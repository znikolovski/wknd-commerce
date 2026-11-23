const { verifyTargetBindingCas } = require('../lib/verify-target-binding-cas');
const { createMemoryStore } = require('../lib/store');
const { BINDING_COLLECTION } = require('../lib/target-binding-store');

const OPTIONS = {
  environment: 'stage', namespace: 'mock-stage', stageNamespace: 'mock-stage',
  productionNamespace: 'mock-production', prefix: 'cas-probe-offline:',
};

test('CAS probe is dry by default and never opens a store', async () => {
  const getStore = jest.fn();
  expect(await verifyTargetBindingCas({ ...OPTIONS, getStore })).toMatchObject({ status: 'dry-run', writes: false });
  expect(getStore).not.toHaveBeenCalled();
});

test.each([
  { environment: 'production' }, { namespace: 'foreign' }, { stageNamespace: '' },
  { productionNamespace: 'mock-stage' }, { prefix: 'customer:' }, { prefix: '' },
  { execute: true, platformNamespace: 'foreign' },
])('unsafe namespace or key prefix is refused without effects: %p', async (change) => {
  const getStore = jest.fn();
  await expect(verifyTargetBindingCas({ ...OPTIONS, ...change, getStore })).rejects.toThrow();
  expect(getStore).not.toHaveBeenCalled();
});

test.each(['stage', 'production'])('CAS probe verifies %s primitives in memory and removes only its disposable key', async (environment) => {
  const namespace = environment === 'stage' ? OPTIONS.stageNamespace : OPTIONS.productionNamespace;
  const store = createMemoryStore();
  await store.collection(BINDING_COLLECTION).insertOne({ _id: 'other-key', etag: 'keep', record: { step: 'keep' } });
  expect(await verifyTargetBindingCas({
    ...OPTIONS, environment, namespace, platformNamespace: namespace, execute: true, getStore: async () => store,
  })).toMatchObject({ status: 'passed', environment, writes: true });
  expect(await store.collection(BINDING_COLLECTION).find({})).toEqual([{ etag: 'keep', record: { step: 'keep' } }]);
});

test('CAS failure is reported, with conditional cleanup of the probe key', async () => {
  const store = createMemoryStore();
  const coll = store.collection(BINDING_COLLECTION);
  jest.spyOn(coll, 'updateOne').mockResolvedValue({ matchedCount: 0 });
  await expect(verifyTargetBindingCas({
    ...OPTIONS, platformNamespace: OPTIONS.namespace, execute: true, getStore: async () => store,
  })).rejects.toThrow('Exactly one conditional writer');
  expect(await coll.find({})).toEqual([]);
});
