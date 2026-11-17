import React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Cell, Column, Flex, Grid, Heading, LabeledValue, Row, StatusLight, TableBody, TableHeader, TableView, Text, View, minmax, repeat
} from '@adobe/react-spectrum'
import { formatDate, formatMoney } from '../api'
import { ErrorAlert, Loading, PageHeader, useAdminQuery } from './common'

function Tile ({ label, value, tone, action }) {
  return (
    <View borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-200' backgroundColor='gray-50'>
      <Flex direction='column' gap='size-100'>
        <LabeledValue label={label} value={value} />
        {tone && <StatusLight variant={tone}>{tone === 'positive' ? 'Healthy' : 'Needs attention'}</StatusLight>}
        {action}
      </Flex>
    </View>
  )
}

export default function Dashboard () {
  const navigate = useNavigate()
  const stats = useAdminQuery('stats.get')
  const orders = useAdminQuery('orders.list', { pageSize: 5 })
  const s = stats.data

  return (
    <>
      <PageHeader title='Dashboard' description='WKND Adventures Shop — mock Adobe Commerce backend (API Mesh + App Builder).' />
      <ErrorAlert error={stats.error} onRetry={stats.reload} />
      {stats.loading && !s ? <Loading label='Loading store statistics' /> : s && (
        <Grid columns={repeat('auto-fit', minmax('size-2400', '1fr'))} gap='size-200' marginBottom='size-400'>
          <Tile label='Products' value={`${s.enabled} enabled / ${s.products}`} action={<Button variant='secondary' onPress={() => navigate('/products')}>Manage products</Button>} />
          <Tile label='Sellable SKUs' value={s.sellableSkus} />
          <Tile label='Out of stock' value={s.outOfStock} tone={s.outOfStock ? 'negative' : 'positive'} action={<Button variant='secondary' onPress={() => navigate('/inventory')}>Review stock</Button>} />
          <Tile label='Low stock' value={s.lowStock} tone={s.lowStock ? 'notice' : 'positive'} />
          <Tile label='On sale' value={s.onSale} action={<Button variant='secondary' onPress={() => navigate('/pricing')}>Manage pricing</Button>} />
          <Tile label='Without images' value={s.withoutImages} tone={s.withoutImages ? 'notice' : 'positive'} />
          <Tile label='Demo orders' value={s.orders} />
          <Tile label='Demo revenue' value={formatMoney(s.revenue)} />
        </Grid>
      )}
      <Heading level={2}>Recent orders</Heading>
      <ErrorAlert error={orders.error} onRetry={orders.reload} />
      <TableView aria-label='Recent orders' density='compact' onAction={(key) => navigate(`/orders/${encodeURIComponent(key)}`)} minHeight='size-1600'>
        <TableHeader>
          <Column key='number'>Order</Column>
          <Column key='createdAt'>Placed</Column>
          <Column key='customer'>Customer</Column>
          <Column key='total' align='end'>Total</Column>
        </TableHeader>
        <TableBody items={orders.data?.items || []} loadingState={orders.loading ? 'loading' : 'idle'}>
          {(o) => (
            <Row key={o.number}>
              <Cell>{o.number}</Cell>
              <Cell>{formatDate(o.createdAt)}</Cell>
              <Cell>{o.customer}</Cell>
              <Cell>{formatMoney(o.total)}</Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
      {s && <Text marginTop='size-200' UNSAFE_style={{ display: 'block' }}>Catalog version {s.catalogVersion}</Text>}
    </>
  )
}
