import React, { useState } from 'react'
import {
  Button, Content, Flex, Heading, InlineAlert, NumberField, Text, TextField, View
} from '@adobe/react-spectrum'
import { callAdmin, formatDate, formatMoney } from '../api'
import { useShell } from '../shell-context'
import { ErrorAlert } from './common'

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim().length > 0
const isDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isBuffer = (value) => isCount(value) && value <= 20
const isIdentifier = (value) => isText(value) && value === value.trim()
const hasExpiredQuote = (data) => data.opportunities.some(({ quoteExpiresAt }) => Date.parse(quoteExpiresAt) <= Date.now())
const expiredQuoteError = () => new Error('The bundle quote has expired. Investigate bundles again for a fresh quote.')

function validateResponse (data) {
  if (!isRecord(data) || data.apiVersion !== 'wknd.bundling/v1' || !isDate(data.asOf) || data.currency !== 'AUD' ||
    !isRecord(data.window) || !isDate(data.window.startsAt) || !isDate(data.window.endsAt) ||
    !isRecord(data.evidence) || !isText(data.evidence.provenance) ||
    !['ordersMatched', 'ordersScanned', 'orderLimit'].every((key) => isCount(data.evidence[key])) ||
    typeof data.evidence.truncated !== 'boolean' ||
    !Array.isArray(data.evidence.missingMetrics) || !data.evidence.missingMetrics.every(isText) ||
    !Array.isArray(data.opportunities) || data.opportunities.length > 10 ||
    data.evidence.orderLimit < 1 || data.evidence.orderLimit > 500 ||
    data.evidence.ordersMatched > data.evidence.ordersScanned || data.evidence.ordersScanned > data.evidence.orderLimit ||
    Date.parse(data.window.startsAt) >= Date.parse(data.window.endsAt)) return false

  const bundleIds = new Set()
  return data.opportunities.every((opportunity) => {
    if (!isRecord(opportunity) || typeof opportunity.bundleId !== 'string' ||
      !/^bnd_[a-f0-9]{32}$/.test(opportunity.bundleId) || bundleIds.has(opportunity.bundleId) ||
      !(opportunity.experimentId === null || (isIdentifier(opportunity.experimentId) && opportunity.experimentId.length <= 64)) ||
      !['name', 'classification', 'scoreExplanation'].every((key) => isText(opportunity[key])) ||
      !isDate(opportunity.quoteExpiresAt) || !isBuffer(opportunity.safetyBuffer) ||
      Date.parse(opportunity.quoteExpiresAt) > Date.parse(data.asOf) + 15 * 60 * 1000 ||
      (opportunity.score !== undefined && !Number.isFinite(opportunity.score)) ||
      (opportunity.shippingIncluded !== undefined && opportunity.shippingIncluded !== false) ||
      (opportunity.financiallyApproved !== undefined && opportunity.financiallyApproved !== false) ||
      (opportunity.aero !== undefined && (!isRecord(opportunity.aero) ||
        opportunity.aero.separatePurchase !== true || opportunity.aero.atomicReservation !== false)) ||
      !isCount(opportunity.merchandiseMinor) ||
      !Array.isArray(opportunity.components) || opportunity.components.length < 2 || opportunity.components.length > 5) return false
    bundleIds.add(opportunity.bundleId)
    const skus = new Set()
    let merchandiseMinor = 0
    const validComponents = opportunity.components.every((component) => {
      if (!isRecord(component) || !isIdentifier(component.sku) || skus.has(component.sku) ||
        !['quantity', 'unitPriceMinor', 'availableQuantity', 'unitsSold'].every((key) => isCount(component[key])) ||
        component.quantity === 0 || component.quantity > 20 || component.unitPriceMinor === 0) return false
      skus.add(component.sku)
      const lineMinor = component.quantity * component.unitPriceMinor
      merchandiseMinor += lineMinor
      return isCount(lineMinor) && isCount(merchandiseMinor)
    })
    return validComponents && merchandiseMinor === opportunity.merchandiseMinor
  })
}

export function bundleDraft (opportunity) {
  return {
    name: opportunity.name,
    enabled: false,
    mode: 'automatic',
    discount: { kind: 'percentage', basisPoints: 500 },
    target: {
      kind: 'bundle',
      bundleId: opportunity.bundleId,
      experimentId: opportunity.experimentId,
      currency: 'AUD',
      quoteExpiresAt: opportunity.quoteExpiresAt,
      safetyBuffer: opportunity.safetyBuffer,
      components: opportunity.components.map(({ sku, quantity, unitPriceMinor }) => ({
        sku, quantity, unitPriceMinor
      }))
    }
  }
}

export default function BundleOpportunities ({ onSelect }) {
  const { ims } = useShell()
  const [category, setCategory] = useState('')
  const [buffer, setBuffer] = useState(2)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const expired = result && hasExpiredQuote(result)

  const analyze = async () => {
    setPending(true)
    setError(null)
    setResult(null)
    try {
      if (!isBuffer(buffer)) throw new Error('The stock safety buffer must be an integer between 0 and 20.')
      const data = await callAdmin(ims, 'promotions.bundleOpportunities', {
        limit: 5, safetyBuffer: buffer, ...(category.trim() ? { category: category.trim() } : {})
      }, { endpoint: 'promotions' })
      if (data?.ok === false) throw new Error(isText(data.error?.message) ? data.error.message : 'Bundle investigation was rejected.')
      if (!validateResponse(data)) {
        throw new Error('The bundle investigation returned an invalid response.')
      }
      if (hasExpiredQuote(data)) throw expiredQuoteError()
      setResult(data)
    } catch (failure) {
      setError(failure)
    } finally {
      setPending(false)
    }
  }

  const select = (opportunity) => {
    if (hasExpiredQuote(result)) {
      setResult(null)
      setError(expiredQuoteError())
      return
    }
    onSelect(bundleDraft(opportunity))
  }

  return (
    <View borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-250' marginBottom='size-300'>
      <Heading level={2} marginTop={0}>Intelligent bundle investigation</Heading>
      <Text>Analyze the last 30 days of completed demo orders and current inventory. Recommendations are read-only; choosing a kit opens a disabled promotion draft for your review.</Text>
      <Flex gap='size-200' wrap alignItems='end' marginY='size-200'>
        <TextField label='Category slug (optional)' value={category} onChange={setCategory} isDisabled={pending} />
        <NumberField label='Stock safety buffer' minValue={0} maxValue={20} value={buffer} onChange={setBuffer} isDisabled={pending} />
        <Button variant='secondary' onPress={analyze} isPending={pending} isDisabled={!ims?.token || !isBuffer(buffer)}>Investigate bundles</Button>
      </Flex>
      <ErrorAlert error={error || (expired ? expiredQuoteError() : null)} onRetry={analyze} title='Bundle investigation failed' />
      {result && !expired && (
        <Flex direction='column' gap='size-200'>
          <InlineAlert variant='info'>
            <Heading>Observed demo evidence, not proven commercial uplift</Heading>
            <Content>
              <Text>{result.evidence.provenance}</Text>
              <Text>{` Window: ${formatDate(result.window.startsAt)} → ${formatDate(result.window.endsAt)}. Snapshot: ${formatDate(result.asOf)}. ${result.evidence.ordersMatched} matched orders from ${result.evidence.ordersScanned} scanned (limit ${result.evidence.orderLimit}). ${result.evidence.truncated ? 'The scan is truncated; this is not the complete reporting period.' : ''}`}</Text>
              <Text>{` Unavailable metrics: ${(result.evidence.missingMetrics || []).join(', ')}. Stock quantity alone does not prove surplus; a discount is not evidence of margin or revenue uplift.`}</Text>
            </Content>
          </InlineAlert>
          {!result.opportunities.length && <Text>No compatible kits meet the stock safety buffer. Change the filter or buffer and investigate again.</Text>}
          {result.opportunities.map((opportunity) => (
            <View key={opportunity.bundleId} borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-200'>
              <Heading level={3} marginTop={0}>{opportunity.name}</Heading>
              <Flex direction='column' gap='size-100'>
                <Text>{`${opportunity.classification}: ${opportunity.scoreExplanation}`}</Text>
                {opportunity.components.map((component) => (
                  <Text key={component.sku}>{`${component.quantity} × ${component.sku} at ${formatMoney(component.unitPriceMinor / 100, result.currency)}; available ${component.availableQuantity}; observed units sold ${component.unitsSold}.`}</Text>
                ))}
                <Text>{`Merchandise: ${formatMoney(opportunity.merchandiseMinor / 100, result.currency)}, excluding shipping. Quote expires ${formatDate(opportunity.quoteExpiresAt)}; refresh if prices, stock or the quote change.`}</Text>
                <Text>Aero is a separate demo flight booking. This kit does not reserve seats, verify baggage or provide a combined flight discount or atomic reservation.</Text>
                <Button variant='secondary' alignSelf='start' onPress={() => select(opportunity)}
                  isDisabled={Date.parse(opportunity.quoteExpiresAt) <= Date.now()}>
                  Use as disabled draft
                </Button>
              </Flex>
            </View>
          ))}
        </Flex>
      )}
    </View>
  )
}
