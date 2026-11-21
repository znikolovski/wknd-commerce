import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertDialog, Badge, Button, ButtonGroup, Cell, Checkbox, CheckboxGroup, Column, Content, DatePicker, Dialog, DialogContainer,
  Divider, Flex, Form, Heading, InlineAlert, NumberField, Radio, RadioGroup, Row, StatusLight, Switch, TableBody, TableHeader,
  TableView, Text, TextArea, TextField, ToastQueue, View
} from '@adobe/react-spectrum'
import { callAdmin, formatDate, formatMoney } from '../api'
import { useShell } from '../shell-context'
import { ErrorAlert, PageHeader, useAdminMutation, useAdminQuery } from './common'

const PROMOTIONS = { endpoint: 'promotions' }
const PAGE_SIZE = 50 // service maximum (wknd.promotions/v1 listMax)
const MAX_PAGES = 20
const newKey = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : null)

/** Service envelopes report failures as { ok: false, error }; surface them as one message. */
function serviceError (result) {
  if (!result || result.ok !== false) return null
  const fields = (result.error?.fields || []).map((f) => `${f.path}: ${f.message || f.code}`).join('; ')
  return `${result.error?.message || 'The promotion service rejected the request.'}${fields ? ` (${fields})` : ''}`
}

const describeDiscount = (p) => (p.discount?.kind === 'percentage'
  ? `${p.discount.basisPoints / 100}% off`
  : `${formatMoney((p.discount?.amountMinor || 0) / 100)} off`)

const describeTarget = (t) => {
  if (!t || t.kind === 'all') return 'All products'
  return `${t.kind === 'skus' ? 'SKUs' : 'Categories'}: ${t.values.join(', ')}`
}

const minorOrNull = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null)
const dateOf = (iso) => (iso ? iso.slice(0, 10) : null)
const toIso = (date, endOfDay) => (date ? new Date(`${date.toString()}T${endOfDay ? '23:59:59' : '00:00:00'}Z`).toISOString() : null)

/** Loads every promotion by following nextCursor (pages of PAGE_SIZE). */
function usePromotionList () {
  const { ims } = useShell()
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    const load = async () => {
      const items = []
      let cursor
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const args = cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE }
        // eslint-disable-next-line no-await-in-loop
        const result = await callAdmin(ims, 'promotions.list', args, { signal: controller.signal, endpoint: 'promotions' })
        if (result?.ok === false) return result
        items.push(...(result.items || []))
        cursor = result.nextCursor
        if (!cursor) break
      }
      return { ok: true, items }
    }
    load()
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => { if (error.name !== 'AbortError') setState((s) => ({ ...s, error, loading: false })) })
    return () => controller.abort()
  }, [ims.token, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, reload }
}

export default function Promotions () {
  const list = usePromotionList()
  const categories = useAdminQuery('categories.list')
  const { mutate, pending } = useAdminMutation(PROMOTIONS)
  const [editing, setEditing] = useState(null)
  const listError = serviceError(list.data)
  const items = list.data?.items || []

  const run = async (op, args, success) => {
    const result = await mutate(op, args).catch(() => null)
    const error = serviceError(result)
    if (error) ToastQueue.negative(error, { timeout: 10000 })
    else if (result && success) ToastQueue.positive(success, { timeout: 4000 })
    return error || !result ? null : result
  }

  const toggle = async (p) => {
    const done = await run('promotions.setEnabled', { id: p.id, expectedRevision: p.revision, enabled: !p.enabled, idempotencyKey: newKey() },
      `${p.name} ${p.enabled ? 'disabled' : 'enabled'}`)
    list.reload()
    return done
  }

  return (
    <>
      <PageHeader
        title='Promotions'
        description='Coupons and automatic offers from the shared promotion engine. One promotion per cart; shoppers get the highest saving. Changes here are audited under your Adobe ID.'
        actions={<Button variant='accent' onPress={() => setEditing({})}>New promotion</Button>}
      />
      <ErrorAlert error={list.error || (listError && { message: listError })} onRetry={list.reload} />
      <TableView aria-label='Promotions' density='compact' height='size-4600' marginBottom='size-400'>
        <TableHeader>
          <Column key='name' width='2fr'>Promotion</Column>
          <Column key='type'>Type</Column>
          <Column key='discount'>Discount</Column>
          <Column key='limits'>Cap / minimum</Column>
          <Column key='target' width='2fr'>Applies to</Column>
          <Column key='dates'>Dates (UTC)</Column>
          <Column key='status'>Status</Column>
          <Column key='actions' align='end'>Actions</Column>
        </TableHeader>
        <TableBody items={items} loadingState={list.loading ? 'loading' : 'idle'}>
          {(p) => (
            <Row key={p.id}>
              <Cell>
                <Flex gap='size-100' alignItems='center'>
                  <Text>{p.name}</Text>
                  {p.managementClass === 'protected-recovery' && <Badge variant='info'>Protected</Badge>}
                </Flex>
              </Cell>
              <Cell>{p.mode === 'coupon' ? `Coupon ${p.code}` : 'Automatic'}</Cell>
              <Cell>{describeDiscount(p)}</Cell>
              <Cell>{`${p.maxDiscountMinor != null ? `max ${formatMoney(p.maxDiscountMinor / 100)}` : 'no cap'} / ${p.minimumMerchandiseMinor != null ? formatMoney(p.minimumMerchandiseMinor / 100) : 'none'}`}</Cell>
              <Cell>{describeTarget(p.target)}</Cell>
              <Cell>{p.startsAt || p.endsAt ? `${dateOf(p.startsAt) || '…'} → ${dateOf(p.endsAt) || '…'}` : 'Always'}</Cell>
              <Cell><StatusLight variant={p.enabled ? 'positive' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</StatusLight></Cell>
              <Cell>
                <Flex gap='size-100' justifyContent='end'>
                  <Switch isSelected={p.enabled} isDisabled={pending} onChange={() => toggle(p)} aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}>
                    {p.enabled ? 'On' : 'Off'}
                  </Switch>
                  <Button variant='secondary' onPress={() => setEditing(p)}>Edit</Button>
                </Flex>
              </Cell>
            </Row>
          )}
        </TableBody>
      </TableView>

      <RecoveryEmailRuns />

      <DialogContainer type='fullscreenTakeover' onDismiss={() => setEditing(null)}>
        {editing && (
          <PromotionEditor
            promotion={editing.id ? editing : null}
            categories={categories.data?.items || []}
            pending={pending}
            onSave={async (args) => {
              const op = editing.id ? 'promotions.update' : 'promotions.create'
              const done = await run(op, args, editing.id ? 'Promotion saved' : 'Promotion created (disabled until you enable it)')
              if (done) {
                setEditing(null)
                list.reload()
              }
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </DialogContainer>
    </>
  )
}

function PromotionEditor ({ promotion, categories, pending, onSave, onCancel }) {
  const p = promotion || {}
  const isProtected = p.managementClass === 'protected-recovery'
  const [name, setName] = useState(p.name || '')
  const [mode, setMode] = useState(p.mode || 'coupon')
  const [code, setCode] = useState(p.code || '')
  const [kind, setKind] = useState(p.discount?.kind || 'percentage')
  const [percent, setPercent] = useState(p.discount?.kind === 'percentage' ? p.discount.basisPoints / 10000 : 0.1)
  const [amount, setAmount] = useState(p.discount?.kind === 'fixed' ? p.discount.amountMinor / 100 : 10)
  const [cap, setCap] = useState(p.maxDiscountMinor != null ? p.maxDiscountMinor / 100 : NaN)
  const [minimum, setMinimum] = useState(p.minimumMerchandiseMinor != null ? p.minimumMerchandiseMinor / 100 : NaN)
  const [targetKind, setTargetKind] = useState(p.target?.kind || 'all')
  const [targetCategories, setTargetCategories] = useState(p.target?.kind === 'categories' ? p.target.values : [])
  const [skus, setSkus] = useState(p.target?.kind === 'skus' ? p.target.values.join(', ') : '')
  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [enabled, setEnabled] = useState(Boolean(p.enabled))
  const [confirm, setConfirm] = useState(false)
  const sortedCategories = useMemo(() => [...categories].sort((a, b) => a.urlPath.localeCompare(b.urlPath)), [categories])

  const definition = () => ({
    name: name.trim(),
    enabled,
    mode,
    code: mode === 'coupon' ? code.trim().toUpperCase() : null,
    discount: kind === 'percentage'
      ? { kind: 'percentage', basisPoints: Math.round(percent * 10000) }
      : { kind: 'fixed', amountMinor: Math.round(amount * 100), currency: 'AUD' },
    maxDiscountMinor: minorOrNull(cap),
    minimumMerchandiseMinor: minorOrNull(minimum),
    target: targetKind === 'all'
      ? { kind: 'all' }
      : { kind: targetKind, values: targetKind === 'categories' ? targetCategories : skus.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean) },
    startsAt: from ? toIso(from) : (promotion ? p.startsAt : null),
    endsAt: to ? toIso(to, true) : (promotion ? p.endsAt : null),
    audienceRestriction: null
  })

  const save = () => {
    const args = { promotion: definition(), idempotencyKey: newKey() }
    if (promotion) Object.assign(args, { id: p.id, expectedRevision: p.revision })
    return onSave(args)
  }

  return (
    <Dialog>
      <Heading>{promotion ? `Edit ${p.name}` : 'New promotion'}</Heading>
      <Divider />
      <Content>
        {isProtected && (
          <InlineAlert variant='info' marginBottom='size-200'>
            <Heading>Protected recovery offer</Heading>
            <Content>The discount, cap, code and eligibility are fixed by the recovery policy (one use per shopper, server-verified inactive carts). Only the name and status can change here.</Content>
          </InlineAlert>
        )}
        <Form aria-label='Promotion' maxWidth='size-6000' isDisabled={pending} onSubmit={(e) => { e.preventDefault(); setConfirm(true) }}>
          <TextField label='Name' isRequired value={name} onChange={setName} maxLength={120} />
          <RadioGroup label='Type' orientation='horizontal' value={mode} onChange={setMode} isDisabled={isProtected}>
            <Radio value='coupon'>Coupon code</Radio>
            <Radio value='automatic'>Automatic (no code)</Radio>
          </RadioGroup>
          {mode === 'coupon' && <TextField label='Code' isRequired value={code} onChange={setCode} isDisabled={isProtected} description='Letters and numbers; shoppers enter it in the cart.' />}
          <RadioGroup label='Discount' orientation='horizontal' value={kind} onChange={setKind} isDisabled={isProtected}>
            <Radio value='percentage'>Percentage</Radio>
            <Radio value='fixed'>Fixed amount (AUD)</Radio>
          </RadioGroup>
          {kind === 'percentage'
            ? <NumberField label='Percentage off' minValue={0.01} maxValue={1} step={0.01} value={percent} onChange={setPercent} formatOptions={{ style: 'percent' }} isDisabled={isProtected} />
            : <NumberField label='Amount off' minValue={0.01} step={0.01} value={amount} onChange={setAmount} formatOptions={{ style: 'currency', currency: 'AUD' }} isDisabled={isProtected} />}
          <Flex gap='size-200' wrap>
            <NumberField label='Maximum discount (optional)' minValue={0.01} step={0.01} value={cap} onChange={setCap} formatOptions={{ style: 'currency', currency: 'AUD' }} isDisabled={isProtected} />
            <NumberField label='Minimum spend (optional)' minValue={0.01} step={0.01} value={minimum} onChange={setMinimum} formatOptions={{ style: 'currency', currency: 'AUD' }} isDisabled={isProtected} />
          </Flex>
          <RadioGroup label='Applies to' orientation='horizontal' value={targetKind} onChange={setTargetKind} isDisabled={isProtected}>
            <Radio value='all'>All products</Radio>
            <Radio value='categories'>Categories</Radio>
            <Radio value='skus'>Specific SKUs</Radio>
          </RadioGroup>
          {targetKind === 'categories' && (
            <CheckboxGroup label='Categories (subcategories included)' value={targetCategories} onChange={setTargetCategories} isDisabled={isProtected}>
              {sortedCategories.map((c) => <Checkbox key={c.urlPath} value={c.urlPath}>{c.name} ({c.urlPath})</Checkbox>)}
            </CheckboxGroup>
          )}
          {targetKind === 'skus' && <TextArea label='SKUs' value={skus} onChange={setSkus} isDisabled={isProtected} description='Comma or space separated; product SKUs include all variants.' />}
          <Flex gap='size-200' wrap>
            <DatePicker label={`Starts (UTC)${p.startsAt ? `, now ${dateOf(p.startsAt)}` : ''}`} value={from} onChange={setFrom} isDisabled={isProtected} />
            <DatePicker label={`Ends (UTC)${p.endsAt ? `, now ${dateOf(p.endsAt)}` : ''}`} value={to} onChange={setTo} isDisabled={isProtected} />
          </Flex>
          <Switch isSelected={enabled} onChange={setEnabled}>{enabled ? 'Enabled — shoppers can get this offer' : 'Disabled (draft)'}</Switch>
          <Text>Sale prices apply first; then the single promotion with the highest saving for the cart.</Text>
        </Form>
        <DialogContainer onDismiss={() => setConfirm(false)}>
          {confirm && (
            <AlertDialog
              title={promotion ? 'Save changes?' : 'Create promotion?'}
              variant='confirmation'
              primaryActionLabel={promotion ? 'Save' : 'Create'}
              cancelLabel='Cancel'
              onPrimaryAction={save}
            >
              {enabled ? 'This offer will be live for shoppers as soon as it is saved.' : 'The offer stays disabled until you enable it.'}
            </AlertDialog>
          )}
        </DialogContainer>
      </Content>
      <ButtonGroup>
        <Button variant='secondary' onPress={onCancel}>Cancel</Button>
        <Button variant='accent' onPress={() => setConfirm(true)} isPending={pending} isDisabled={!name.trim() || (mode === 'coupon' && !code.trim())}>
          {promotion ? 'Save' : 'Create'}
        </Button>
      </ButtonGroup>
    </Dialog>
  )
}

function RecoveryEmailRuns () {
  const status = useAdminQuery('email.status', {}, [], PROMOTIONS)
  const runs = useAdminQuery('email.runs', { limit: 20 }, [], PROMOTIONS)
  const { mutate, pending } = useAdminMutation(PROMOTIONS)
  const [size, setSize] = useState(10)
  const [approve, setApprove] = useState(null)
  const s = status.data
  const reload = () => { status.reload(); runs.reload() }
  const act = async (op, args, message) => {
    await mutate(op, args, message).catch(() => null)
    reload()
  }

  return (
    <View borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-250'>
      <Heading level={2} marginTop={0}>Cart reminder emails</Heading>
      <Text>Runs are requested here or by CX Coworker and must be approved by a different person. Sending is not available from this screen.</Text>
      <ErrorAlert error={status.error || runs.error} onRetry={reload} />
      {s && (
        <Flex gap='size-300' wrap marginY='size-200'>
          <StatusLight variant={s.paused ? 'notice' : 'positive'}>{s.paused ? 'Paused' : 'Active'}</StatusLight>
          <Text>Offer ready: {s.offerReady ? 'yes' : 'no'}</Text>
          <Text>Template: {s.templateConfigured ? 'configured' : 'missing'}</Text>
          <Text>Test allowlist: {s.allowlistEnabled ? `${s.allowlistSize} address(es)` : 'off'}</Text>
          <Text>Sent today: {s.sentToday} / {s.dailyBudget}</Text>
          <Text>Eligible now: {s.audience?.eligible ?? 0}</Text>
        </Flex>
      )}
      <Flex gap='size-200' alignItems='end' wrap marginBottom='size-200'>
        <NumberField label='Recipients (max 50)' minValue={1} maxValue={50} value={size} onChange={setSize} width='size-2000' />
        <Button variant='secondary' isPending={pending} onPress={() => act('email.requestRun', { maxRecipients: size }, 'Run requested — another person must approve it')}>Request run</Button>
        {s && <Button variant='secondary' isDisabled={pending} onPress={() => act(s.paused ? 'email.resume' : 'email.pause', {}, s.paused ? 'Reminder emails resumed' : 'Reminder emails paused')}>{s.paused ? 'Resume' : 'Pause'}</Button>}
      </Flex>
      <TableView aria-label='Reminder email runs' density='compact' height='size-3000'>
        <TableHeader>
          <Column key='run'>Run</Column>
          <Column key='state'>State</Column>
          <Column key='size' align='end'>Recipients</Column>
          <Column key='requested'>Requested</Column>
          <Column key='approved'>Approved</Column>
          <Column key='action' align='end'>Action</Column>
        </TableHeader>
        <TableBody items={runs.data || []} loadingState={runs.loading ? 'loading' : 'idle'}>
          {(r) => (
            <Row key={r.runId}>
              <Cell>{r.runId}</Cell>
              <Cell>{r.state}</Cell>
              <Cell>{`${r.sent} / ${r.maxRecipients}`}</Cell>
              <Cell>{`${formatDate(r.requestedAt)} by ${r.requestedBy}`}</Cell>
              <Cell>{r.approvedAt ? `${formatDate(r.approvedAt)} by ${r.approvedBy}` : '—'}</Cell>
              <Cell>{r.state === 'requested' ? <Button variant='accent' isDisabled={pending} onPress={() => setApprove(r)}>Approve</Button> : <Text>—</Text>}</Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
      <DialogContainer onDismiss={() => setApprove(null)}>
        {approve && (
          <AlertDialog
            title='Approve this reminder run?'
            variant='confirmation'
            primaryActionLabel='Approve'
            cancelLabel='Cancel'
            onPrimaryAction={() => act('email.approveRun', { runId: approve.runId, templateId: approve.templateId, maxRecipients: approve.maxRecipients }, 'Run approved')}
          >
            {`Up to ${approve.maxRecipients} opted-in shoppers with an inactive cart may receive Brevo template ${approve.templateId}, each at most once per cart. Consent, suppression, the allowlist and the daily budget are rechecked for every recipient when the run executes.`}
          </AlertDialog>
        )}
      </DialogContainer>
    </View>
  )
}
