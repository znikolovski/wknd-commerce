import React, { useMemo, useState } from 'react'
import {
  Badge, Button, ButtonGroup, Cell, Column, Flex, NumberField, Row, SearchField, StatusLight, Switch, TableBody, TableHeader, TableView, Text
} from '@adobe/react-spectrum'
import { Empty, ErrorAlert, PageHeader, useAdminMutation, useAdminQuery } from './common'

function stockState (qty, threshold) {
  if (qty <= 0) return ['negative', 'Out of stock']
  if (qty <= threshold) return ['notice', 'Low']
  return ['positive', 'In stock']
}

export default function Inventory () {
  const [q, setQ] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [edits, setEdits] = useState({})
  const list = useAdminQuery('inventory.list', { q, lowStockOnly: lowOnly }, [q, lowOnly])
  const { mutate, pending } = useAdminMutation()
  const items = useMemo(() => list.data?.items || [], [list.data])
  const dirty = Object.keys(edits)

  const edit = (row, patch) => {
    const next = { qty: row.qty, lowStockThreshold: row.lowStockThreshold, ...edits[row.sku], ...patch }
    const unchanged = next.qty === row.qty && next.lowStockThreshold === row.lowStockThreshold
    setEdits((e) => {
      const copy = { ...e }
      if (unchanged) delete copy[row.sku]
      else copy[row.sku] = next
      return copy
    })
  }

  const save = async () => {
    await mutate('inventory.update', { items: dirty.map((sku) => ({ sku, ...edits[sku] })) }, `Updated stock for ${dirty.length} SKU(s)`)
    setEdits({})
    list.reload()
  }

  return (
    <>
      <PageHeader
        title='Inventory'
        description={`${items.length} sellable SKUs · checkout decrements stock atomically`}
        actions={(
          <ButtonGroup>
            <Button variant='secondary' isDisabled={!dirty.length || pending} onPress={() => setEdits({})}>Discard</Button>
            <Button variant='accent' isDisabled={!dirty.length} isPending={pending} onPress={save}>
              {dirty.length ? `Save ${dirty.length} change${dirty.length > 1 ? 's' : ''}` : 'Save changes'}
            </Button>
          </ButtonGroup>
        )}
      />
      <Flex gap='size-300' alignItems='end' wrap marginBottom='size-200'>
        <SearchField label='Search' aria-label='Search inventory by SKU or product' width='size-3600' onSubmit={setQ} onClear={() => setQ('')} />
        <Switch isSelected={lowOnly} onChange={setLowOnly}>Low and out of stock only</Switch>
      </Flex>
      <ErrorAlert error={list.error} onRetry={list.reload} />
      <TableView aria-label='Stock per sellable SKU' density='compact' overflowMode='wrap' height='size-6000'
        renderEmptyState={() => <Empty title='Nothing to show'>{lowOnly ? 'No SKUs are low on stock.' : 'No SKUs match your search.'}</Empty>}>
        <TableHeader>
          <Column key='name' width='2fr'>Product</Column>
          <Column key='sku'>SKU</Column>
          <Column key='state'>State</Column>
          <Column key='qty' width={140}>Quantity</Column>
          <Column key='low' width={140}>Low-stock at</Column>
        </TableHeader>
        <TableBody items={items} loadingState={list.loading ? 'loading' : 'idle'}>
          {(row) => {
            const current = { qty: row.qty, lowStockThreshold: row.lowStockThreshold, ...edits[row.sku] }
            const [tone, label] = stockState(current.qty, current.lowStockThreshold)
            return (
              <Row key={row.sku}>
                <Cell>
                  <Flex direction='column'>
                    <Text>{row.name}</Text>
                    {row.variant && <Text UNSAFE_style={{ fontSize: 12, color: 'var(--spectrum-global-color-gray-700)' }}>{row.variant}</Text>}
                  </Flex>
                </Cell>
                <Cell>
                  <Flex gap='size-100' alignItems='center'>
                    <Text>{row.sku}</Text>
                    {row.status === 'disabled' && <Badge variant='neutral'>Disabled</Badge>}
                  </Flex>
                </Cell>
                <Cell><StatusLight variant={tone}>{label}{edits[row.sku] ? ' (unsaved)' : ''}</StatusLight></Cell>
                <Cell><NumberField aria-label={`Quantity for ${row.sku}`} isQuiet minValue={0} step={1} value={current.qty} onChange={(v) => edit(row, { qty: Math.floor(v || 0) })} /></Cell>
                <Cell><NumberField aria-label={`Low-stock threshold for ${row.sku}`} isQuiet minValue={0} step={1} value={current.lowStockThreshold} onChange={(v) => edit(row, { lowStockThreshold: Math.floor(v || 0) })} /></Cell>
              </Row>
            )
          }}
        </TableBody>
      </TableView>
    </>
  )
}
