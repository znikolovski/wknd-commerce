import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Badge, Button, Cell, Column, Divider, Flex, Grid, Heading, LabeledValue, Row, TableBody, TableHeader, TableView, Text, View, minmax, repeat
} from '@adobe/react-spectrum'
import { formatDate, formatMoney } from '../api'
import { ErrorAlert, Loading, PageHeader, useAdminQuery } from './common'

function Address ({ title, address }) {
  if (!address) return null
  return (
    <View>
      <Heading level={3}>{title}</Heading>
      <Text UNSAFE_style={{ whiteSpace: 'pre-line' }}>
        {[`${address.firstname} ${address.lastname}`, address.company, ...(address.street || []),
          `${address.city} ${address.region_code || address.region_label || ''} ${address.postcode}`, address.country_code, address.telephone]
          .filter(Boolean).join('\n')}
      </Text>
    </View>
  )
}

export default function OrderDetail () {
  const { number } = useParams()
  const navigate = useNavigate()
  const detail = useAdminQuery('orders.get', { number }, [number])
  if (detail.loading && !detail.data) return <Loading label='Loading order' />
  if (detail.error) return <ErrorAlert error={detail.error} onRetry={detail.reload} title='Could not load order' />
  const { order } = detail.data
  const t = order.totals
  return (
    <>
      <PageHeader
        title={`Order ${order.number}`}
        description={`Placed ${formatDate(order.createdAt)} · ${order.customerSub ? 'Signed-in customer' : 'Guest'} · ${order.email}`}
        actions={<Button variant='secondary' onPress={() => navigate('/orders')}>Back to orders</Button>}
      />
      <Flex gap='size-100' marginBottom='size-200'>
        <Badge variant='info'>{order.status}</Badge>
        {order.demo && <Badge variant='yellow'>Demo order</Badge>}
      </Flex>
      <TableView aria-label='Order items' density='compact' overflowMode='wrap'>
        <TableHeader>
          <Column key='name' width='2fr'>Item</Column>
          <Column key='sku'>SKU</Column>
          <Column key='qty' align='end'>Qty</Column>
          <Column key='price' align='end'>Price</Column>
          <Column key='row' align='end'>Row total</Column>
        </TableHeader>
        <TableBody items={order.items}>
          {(i) => (
            <Row key={i.id}>
              <Cell>
                <Flex direction='column'>
                  <Text>{i.name}</Text>
                  {i.options?.length > 0 && <Text UNSAFE_style={{ fontSize: 12 }}>{i.options.map((o) => `${o.label}: ${o.value}`).join(' · ')}</Text>}
                </Flex>
              </Cell>
              <Cell>{i.sku}</Cell>
              <Cell>{i.quantity}</Cell>
              <Cell>{formatMoney(i.price)}</Cell>
              <Cell>{formatMoney(i.rowTotal)}</Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
      <Grid columns={repeat('auto-fit', minmax('size-3000', '1fr'))} gap='size-300' marginTop='size-300'>
        <View>
          <Heading level={3}>Totals</Heading>
          <Flex direction='column' gap='size-100'>
            <LabeledValue label='Subtotal (incl. GST)' value={formatMoney(t.subtotalIncl)} />
            {t.discountTotal > 0 && <LabeledValue label={`Discounts${order.coupons?.length ? ` (${order.coupons.join(', ')})` : ''}`} value={`−${formatMoney(t.discountTotal)}`} />}
            <LabeledValue label={order.shippingMethod?.title || 'Shipping'} value={formatMoney(t.shipping)} />
            <LabeledValue label='GST included' value={formatMoney(t.tax)} />
            <Divider size='S' />
            <LabeledValue label='Grand total' value={formatMoney(t.grandTotal)} />
          </Flex>
        </View>
        <View>
          <Heading level={3}>Payment</Heading>
          <LabeledValue label={order.payment?.title || 'Payment'} value={order.payment?.reference || '—'} />
        </View>
        <Address title='Shipping address' address={order.shippingAddress} />
        <Address title='Billing address' address={order.billingAddress} />
      </Grid>
    </>
  )
}
