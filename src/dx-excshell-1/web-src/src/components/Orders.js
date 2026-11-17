import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Badge, Button, Cell, Column, Flex, Row, SearchField, TableBody, TableHeader, TableView, Text
} from '@adobe/react-spectrum'
import { formatDate, formatMoney } from '../api'
import { Empty, ErrorAlert, PageHeader, useAdminQuery } from './common'

const PAGE_SIZE = 25

export default function Orders () {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const list = useAdminQuery('orders.list', { q, page, pageSize: PAGE_SIZE }, [q, page])
  const total = list.data?.total || 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <>
      <PageHeader title='Orders' description={`${total} demo orders · paid with WKND Demo Pay (no real payment)`} />
      <SearchField label='Search' aria-label='Search orders by number or email' width='size-3600' marginBottom='size-200'
        onSubmit={(v) => { setPage(1); setQ(v) }} onClear={() => { setPage(1); setQ('') }} />
      <ErrorAlert error={list.error} onRetry={list.reload} />
      <TableView aria-label='Orders' density='compact' onAction={(key) => navigate(`/orders/${encodeURIComponent(key)}`)} minHeight='size-3600'
        renderEmptyState={() => <Empty title='No orders yet'>Place an order on the storefront to see it here.</Empty>}>
        <TableHeader>
          <Column key='number'>Order</Column>
          <Column key='createdAt'>Placed</Column>
          <Column key='email'>Email</Column>
          <Column key='customer'>Customer</Column>
          <Column key='items' align='end'>Items</Column>
          <Column key='total' align='end'>Total</Column>
          <Column key='status'>Status</Column>
        </TableHeader>
        <TableBody items={list.data?.items || []} loadingState={list.loading ? 'loading' : 'idle'}>
          {(o) => (
            <Row key={o.number}>
              <Cell>{o.number}</Cell>
              <Cell>{formatDate(o.createdAt)}</Cell>
              <Cell>{o.email}</Cell>
              <Cell>{o.customer}</Cell>
              <Cell>{o.items}</Cell>
              <Cell>{formatMoney(o.total)}</Cell>
              <Cell><Badge variant='info'>{o.status}</Badge></Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
      <Flex justifyContent='space-between' alignItems='center' marginTop='size-200'>
        <Text>Page {page} of {pages}</Text>
        <Flex gap='size-100'>
          <Button variant='secondary' isDisabled={page <= 1} onPress={() => setPage(page - 1)}>Previous</Button>
          <Button variant='secondary' isDisabled={page >= pages} onPress={() => setPage(page + 1)}>Next</Button>
        </Flex>
      </Flex>
    </>
  )
}
