import React, { useState } from 'react'
import {
  AlertDialog, Badge, Button, ButtonGroup, Cell, Column, DatePicker, DialogContainer, Flex, Form, Heading, Item, NumberField, Picker,
  Radio, RadioGroup, Row, SearchField, TableBody, TableHeader, TableView, Text, View
} from '@adobe/react-spectrum'
import { formatMoney } from '../api'
import { ErrorAlert, PageHeader, useAdminMutation, useAdminQuery } from './common'

const toIso = (date, endOfDay) => (date ? new Date(`${date.toString()}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString() : null)

export default function Pricing () {
  const [category, setCategory] = useState('all')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [scope, setScope] = useState('category')
  const [percent, setPercent] = useState(15)
  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const categories = useAdminQuery('categories.list')
  const list = useAdminQuery('products.list', { q, pageSize: 200, category: category === 'all' ? undefined : category }, [q, category])
  const { mutate, pending } = useAdminMutation()
  const items = list.data?.items || []
  const selectedSkus = selected === 'all' ? items.map((p) => p.sku) : [...selected]
  const topCategories = (categories.data?.items || []).filter((c) => !c.urlPath.includes('/'))
  const target = scope === 'selection'
    ? { skus: selectedSkus, label: `${selectedSkus.length} selected product(s)` }
    : { category: category === 'all' ? '' : category, label: category === 'all' ? 'all products' : `category ${category}` }
  const canApply = scope === 'category' || selectedSkus.length > 0

  const apply = async (clear) => {
    const args = scope === 'selection' ? { skus: selectedSkus } : { category: target.category }
    const result = await mutate('prices.bulk', clear ? { ...args, clear: true } : {
      ...args, percent, specialFrom: toIso(from), specialTo: toIso(to, true)
    }, clear ? `Cleared sale prices on ${target.label}` : `${percent}% sale applied to ${target.label}`)
    if (result) list.reload()
  }

  return (
    <>
      <PageHeader title='Pricing' description='Prices are AUD, GST inclusive. Edit individual SKUs in the product editor.' />
      <View borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-250' marginBottom='size-300'>
        <Heading level={2} marginTop={0}>Bulk sale</Heading>
        <Form aria-label='Bulk sale' maxWidth='size-6000' onSubmit={(e) => { e.preventDefault(); setConfirm('apply') }}>
          <RadioGroup label='Apply to' orientation='horizontal' value={scope} onChange={setScope}>
            <Radio value='category'>Category filter</Radio>
            <Radio value='selection'>Selected products ({selectedSkus.length})</Radio>
          </RadioGroup>
          <NumberField label='Discount' minValue={0.01} maxValue={0.89} step={0.01} value={percent / 100}
            onChange={(v) => setPercent(Math.round((v || 0) * 100))} formatOptions={{ style: 'percent' }} />
          <Flex gap='size-200' wrap>
            <DatePicker label='Starts (optional)' value={from} onChange={setFrom} />
            <DatePicker label='Ends (optional)' value={to} onChange={setTo} />
          </Flex>
          <ButtonGroup>
            <Button variant='accent' type='submit' isDisabled={!canApply} isPending={pending}>Apply sale</Button>
            <Button variant='negative' isDisabled={!canApply || pending} onPress={() => setConfirm('clear')}>Clear sale prices</Button>
          </ButtonGroup>
          <Text>Applies to {target.label}. Sale price = regular × (1 − discount); variants included.</Text>
        </Form>
      </View>
      <Flex gap='size-200' alignItems='end' wrap marginBottom='size-200'>
        <SearchField label='Search' aria-label='Search products to price' width='size-3600' onSubmit={(v) => { setSelected(new Set()); setQ(v) }} onClear={() => setQ('')} />
        <Picker label='Category' selectedKey={category} onSelectionChange={(k) => { setSelected(new Set()); setCategory(k) }} items={[{ urlPath: 'all', name: 'All categories' }, ...topCategories]}>
          {(c) => <Item key={c.urlPath}>{c.name}</Item>}
        </Picker>
      </Flex>
      <ErrorAlert error={list.error} onRetry={list.reload} />
      <TableView aria-label='Product prices' density='compact' selectionMode='multiple' selectedKeys={selected} onSelectionChange={setSelected} height='size-6000'>
        <TableHeader>
          <Column key='name' width='2fr'>Product</Column>
          <Column key='sku'>SKU</Column>
          <Column key='regular' align='end'>Regular from</Column>
          <Column key='price' align='end'>Current price</Column>
          <Column key='sale'>Sale</Column>
        </TableHeader>
        <TableBody items={items} loadingState={list.loading ? 'loading' : 'idle'}>
          {(p) => (
            <Row key={p.sku}>
              <Cell>{p.name}</Cell>
              <Cell>{p.sku}</Cell>
              <Cell>{formatMoney(p.regularMin)}</Cell>
              <Cell>{p.minPrice === p.maxPrice ? formatMoney(p.minPrice) : `${formatMoney(p.minPrice)}–${formatMoney(p.maxPrice)}`}</Cell>
              <Cell>{p.onSale ? <Badge variant='positive'>On sale</Badge> : <Text>—</Text>}</Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
      <DialogContainer onDismiss={() => setConfirm(null)}>
        {confirm && (
          <AlertDialog
            title={confirm === 'clear' ? 'Clear sale prices?' : `Apply a ${percent}% sale?`}
            variant={confirm === 'clear' ? 'destructive' : 'confirmation'}
            primaryActionLabel={confirm === 'clear' ? 'Clear sale prices' : 'Apply sale'}
            cancelLabel='Cancel'
            onPrimaryAction={() => apply(confirm === 'clear')}
          >
            {confirm === 'clear'
              ? `Removes sale prices from ${target.label}. Regular prices are unchanged.`
              : `Sets sale prices on ${target.label}${from || to ? ' for the chosen dates' : ''}. Product pages update within a few seconds.`}
          </AlertDialog>
        )}
      </DialogContainer>
    </>
  )
}
