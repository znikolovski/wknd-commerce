import React, { useEffect, useState } from 'react'
import { Button, Content, Form, Heading, InlineAlert, NumberField, Radio, RadioGroup, Text, TextArea, TextField, View } from '@adobe/react-spectrum'
import { callAdmin } from '../api'
import { useShell } from '../shell-context'

export default function AudienceDraftPreview () {
  const { ims } = useShell()
  const [name, setName] = useState('Climbing audience demo')
  const [audienceKey, setAudienceKey] = useState('climbing-interest')
  const [catalogue, setCatalogue] = useState(null)
  const [percent, setPercent] = useState(10)
  const [cap, setCap] = useState(25)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const [editing, setEditing] = useState(null)
  const [items, setItems] = useState([])
  const [nextAfter, setNextAfter] = useState(null)
  const [createKey, setCreateKey] = useState(() => window.crypto?.randomUUID?.())
  const [activationKey, setActivationKey] = useState(() => window.crypto?.randomUUID?.())
  const [confirmed, setConfirmed] = useState(false)
  const change = (setter) => (value) => { setter(value); setResult(null); setError(null) }
  useEffect(() => {
    let current = true
    callAdmin(ims, 'promotions.authoringAudiences', {}, { endpoint: 'promotions' }).then((data) => {
      if (!current) return
      if (!['stage', 'production'].includes(data.environment) || !data.audiences?.length) {
        setError('Canonical authoring catalogue is unavailable.')
        return
      }
      setCatalogue(data)
    }).catch((e) => { if (current) setError(e.message) })
    return () => { current = false }
  }, [ims.token, ims.org])

  const definition = () => ({
    ...(editing?.promotion || {
      mode: 'automatic', code: null, minimumMerchandiseMinor: null,
      target: { kind: 'all' }, startsAt: null, endsAt: null
    }),
    name, enabled: false,
    discount: editing?.promotion.discount.kind === 'fixed'
      ? { kind: 'fixed', amountMinor: Math.round(percent * 100), currency: 'AUD' }
      : { kind: 'percentage', basisPoints: Math.round(percent * 100) },
    maxDiscountMinor: Number.isFinite(cap) ? Math.round(cap * 100) : null,
    audienceRestriction: { environment: catalogue.environment, key: audienceKey, version: 1 }
  })

  const request = async (method, args) => {
    setPending(true)
    setError(null)
    try {
      const data = await callAdmin(ims, `promotions.drafts.${method}`, args, { endpoint: 'promotions' })
      if (!data.ok) {
        if (data.draft) open(data.draft)
        const fields = (data.error?.fields || []).map((f) => `${f.path}: ${f.message}`).join('; ')
        setError(`${data.error?.message || 'Draft rejected.'}${fields ? ` ${fields}` : ''}`)
        return null
      }
      return data
    } catch (e) {
      setError(e.message)
      return null
    } finally {
      setPending(false)
    }
  }

  const open = (draft) => {
    if (draft.activation?.idempotencyKey) setActivationKey(draft.activation.idempotencyKey)
    if (draft.id !== editing?.id || draft.revision !== editing?.revision) {
      setActivationKey(draft.activation?.idempotencyKey || window.crypto?.randomUUID?.())
      setConfirmed(false)
    }
    setEditing(draft)
    setName(draft.promotion.name)
    setAudienceKey(draft.promotion.audienceRestriction.key)
    setPercent(draft.promotion.discount.kind === 'fixed' ? draft.promotion.discount.amountMinor / 100 : draft.promotion.discount.basisPoints / 100)
    setCap(draft.promotion.maxDiscountMinor == null ? NaN : draft.promotion.maxDiscountMinor / 100)
  }
  const preview = async () => {
    setResult(null)
    const data = await request('validate', { promotion: definition() })
    if (data) setResult(data)
  }
  const save = async () => {
    setResult(null)
    if (!editing && !createKey) {
      setError('This browser cannot generate a secure draft request ID.')
      return
    }
    const data = await request(editing ? 'update' : 'create', {
      promotion: definition(),
      ...(editing ? { id: editing.id, expectedRevision: editing.revision } : { idempotencyKey: createKey })
    })
    if (data) {
      setResult(data)
      open(data.draft)
      setItems((current) => current.map((d) => d.id === data.draft.id ? data.draft : d))
    }
  }
  const load = async (after) => {
    const data = await request('list', { limit: 50, ...(after ? { after } : {}) })
    if (data) {
      setItems((current) => after ? [...current, ...data.items] : data.items)
      setNextAfter(data.nextAfter)
    }
  }
  const remove = async () => {
    const data = await request('delete', { id: editing.id, expectedRevision: editing.revision })
    if (data) {
      setResult(data)
      setItems((current) => current.filter((d) => d.id !== editing.id))
      setEditing(null)
      setCreateKey(window.crypto?.randomUUID?.())
    }
  }
  const activate = async () => {
    const data = await request('activate', {
      id: editing.id, expectedRevision: editing.revision, idempotencyKey: activationKey,
      confirmation: 'Activate Target-backed DEMO offer'
    })
    if (data) { open(data.draft); setResult(data) }
  }
  const demoAvailable = catalogue?.activation?.blocked === false
  const locked = Boolean(editing?.activation)

  return (
    <View borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-250' marginBottom='size-300'>
      <Heading level={2} marginTop={0}>Audience promotion drafts</Heading>
      <InlineAlert variant='info' marginBottom='size-200'>
        <Heading>{catalogue?.environment === 'production' ? 'Production' : catalogue?.environment === 'stage' ? 'Stage' : 'Catalogue unavailable'}. {demoAvailable ? 'Target-backed DEMO activation available.' : 'Activation blocked.'}</Heading>
        <Content>Canonical AAM metadata is not membership evidence. {demoAvailable ? 'An IMS operator may activate demo discounts. Server Target decisions require authenticated shopper identity, current idLinkage consent and server-bound alias. Unknown or nonqualified shoppers receive no restricted discount. Evidence: false; not verified AAM financial membership.' : 'Server demo eligibility is not configured. Disabled drafts can still be saved; activation is unavailable.'}</Content>
      </InlineAlert>
      <Form aria-label='Audience promotion draft' maxWidth='size-6000' isDisabled={pending || !catalogue} onSubmit={(e) => { e.preventDefault(); if (catalogue) preview() }}>
        <TextField label='Draft name' value={name} onChange={change(setName)} isRequired maxLength={120} />
        <RadioGroup label={`Canonical audience (${catalogue?.environment || 'unavailable'})`} value={audienceKey} onChange={change(setAudienceKey)}>
          {(catalogue?.audiences || []).map((a) => <Radio key={a.key} value={a.key}>{a.label} - AAM {a.segmentId}</Radio>)}
        </RadioGroup>
        <NumberField label={editing?.promotion.discount.kind === 'fixed' ? 'Fixed discount (AUD)' : 'Discount percentage'} value={percent} onChange={change(setPercent)} minValue={0.01} maxValue={editing?.promotion.discount.kind === 'fixed' ? 1000000 : 100} step={0.01} />
        <NumberField label='Maximum discount (AUD, optional)' value={cap} onChange={change(setCap)} minValue={0.01} step={0.01} />
        <Text>{editing ? `${editing.id}, revision ${editing.revision}. Other terms are preserved; see the full JSON.` : 'New automatic offer, all products, disabled until explicitly approved for demo activation.'}</Text>
        <Button variant='secondary' onPress={preview} isPending={pending} isDisabled={pending || !catalogue || !name.trim() || !Number.isFinite(percent)}>
          Validate draft
        </Button>
        <Button variant='accent' onPress={save} isDisabled={pending || locked || !catalogue || !name.trim() || !Number.isFinite(percent)}>{editing ? 'Save draft changes' : 'Save disabled draft'}</Button>
        {editing && <Button variant='negative' onPress={remove} isDisabled={pending || locked}>Delete draft</Button>}
        {editing && demoAvailable && editing.state !== 'activated-demo' && <>
          <Button variant='secondary' onPress={() => setConfirmed(!confirmed)} isDisabled={pending}>
            {confirmed ? 'Demo activation confirmed' : 'Confirm saved terms: activate Target-backed DEMO offer'}
          </Button>
          <Text>Activation uses saved revision {editing.revision}, not unsaved form edits. No verified AAM membership claim. After activation, manage or disable the live promotion in Promotions.</Text>
          <Button variant='accent' onPress={activate} isDisabled={pending || !confirmed || !activationKey}>Activate saved demo offer</Button>
        </>}
        <Button variant='secondary' isDisabled={pending} onPress={() => {
          setEditing(null); setName('Climbing audience demo'); setPercent(10); setCap(25); setResult(null); setError(null); setCreateKey(window.crypto?.randomUUID?.()); setConfirmed(false)
        }}>New draft</Button>
      </Form>
      {error && <InlineAlert variant='negative' marginY='size-200'><Heading>Draft request failed</Heading><Content>{error}</Content></InlineAlert>}
      {result && <TextArea label={result.draft?.state === 'activated-demo' ? 'Activated DEMO promotion JSON' : result.persisted ? 'Saved draft JSON (not active)' : 'Validated draft JSON (not saved)'} value={JSON.stringify(result, null, 2)} isReadOnly width='100%' height='size-3600' marginTop='size-200' />}
      <Button variant='secondary' onPress={() => load()} isDisabled={pending || !catalogue} marginTop='size-200'>Load saved drafts</Button>
      {items.map((draft) => <View key={draft.id} marginTop='size-100'>
        <Text>{draft.promotion.name} - {draft.promotion.audienceRestriction.key} - revision {draft.revision}</Text>
        <Button variant='secondary' isDisabled={pending} onPress={async () => {
          const data = await request('get', { id: draft.id })
          if (data) { open(data.draft); setResult(data) }
        }}>Open {draft.promotion.name}</Button>
      </View>)}
      {nextAfter && <Button variant='secondary' onPress={() => load(nextAfter)} isDisabled={pending}>Load more drafts</Button>}
    </View>
  )
}
