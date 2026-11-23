import React, { useState } from 'react'
import { Button, Content, Form, Heading, InlineAlert, NumberField, Radio, RadioGroup, Text, TextArea, TextField, View } from '@adobe/react-spectrum'
import { callAdmin } from '../api'
import { useShell } from '../shell-context'
import audiences from '../../../../../data/promotion-authoring-audiences.json'

export default function AudienceDraftPreview () {
  const { ims } = useShell()
  const [name, setName] = useState('Climbing audience demo')
  const [audienceKey, setAudienceKey] = useState(audiences[0].key)
  const [percent, setPercent] = useState(10)
  const [cap, setCap] = useState(25)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const change = (setter) => (value) => { setter(value); setResult(null); setError(null) }

  const preview = async () => {
    setPending(true)
    setResult(null)
    setError(null)
    try {
      const data = await callAdmin(ims, 'promotions.previewAudienceDraft', {
        environment: 'stage',
        audienceKey,
        promotion: {
          name, enabled: false, mode: 'automatic', code: null,
          discount: { kind: 'percentage', basisPoints: Math.round(percent * 100) },
          maxDiscountMinor: Math.round(cap * 100), minimumMerchandiseMinor: null,
          target: { kind: 'all' }, startsAt: null, endsAt: null, audienceRestriction: null
        }
      }, { endpoint: 'promotions' })
      if (!data.ok) {
        const fields = (data.error?.fields || []).map((f) => `${f.path}: ${f.message}`).join('; ')
        setError(`${data.error?.message || 'Draft rejected.'}${fields ? ` ${fields}` : ''}`)
      } else setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setPending(false)
    }
  }

  return (
    <View borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-250' marginBottom='size-300'>
      <Heading level={2} marginTop={0}>Audience draft - fixture prototype</Heading>
      <InlineAlert variant='info' marginBottom='size-200'>
        <Heading>Stage only. Activation blocked.</Heading>
        <Content>Canonical AAM metadata, not membership evidence. This preview validates disabled draft terms only; it does not save a promotion, evaluate a shopper or authorize a discount. A verified provider is required before activation.</Content>
      </InlineAlert>
      <Form aria-label='Audience fixture draft' maxWidth='size-6000' isDisabled={pending} onSubmit={(e) => { e.preventDefault(); preview() }}>
        <TextField label='Draft name' value={name} onChange={change(setName)} isRequired maxLength={120} />
        <RadioGroup label='Canonical audience (Stage)' value={audienceKey} onChange={change(setAudienceKey)}>
          {audiences.map((a) => <Radio key={a.key} value={a.key}>{a.label} - AAM {a.segmentId}</Radio>)}
        </RadioGroup>
        <NumberField label='Discount percentage' value={percent} onChange={change(setPercent)} minValue={0.01} maxValue={100} step={0.01} />
        <NumberField label='Maximum discount (AUD)' value={cap} onChange={change(setCap)} minValue={0.01} step={0.01} />
        <Text>Automatic offer, all products, disabled. Fixture output is separate from the live v1 definition, whose audienceRestriction remains null.</Text>
        <Button variant='secondary' onPress={preview} isPending={pending} isDisabled={pending || !name.trim() || !Number.isFinite(percent) || !Number.isFinite(cap)}>
          Validate fixture draft
        </Button>
      </Form>
      {error && <InlineAlert variant='negative' marginY='size-200'><Heading>Draft preview failed</Heading><Content>{error}</Content></InlineAlert>}
      {result && <TextArea label='Validated fixture JSON (not saved)' value={JSON.stringify(result, null, 2)} isReadOnly width='100%' height='size-3600' marginTop='size-200' />}
    </View>
  )
}
