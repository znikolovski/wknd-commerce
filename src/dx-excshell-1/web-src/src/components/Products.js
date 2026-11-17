import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ActionButton, AlertDialog, Badge, Button, Cell, Column, DialogContainer, Flex, Item, Menu, MenuTrigger, Picker, Row, SearchField,
  StatusLight, TableBody, TableHeader, TableView, Text
} from '@adobe/react-spectrum'
import More from '@spectrum-icons/workflow/More'
import { formatMoney } from '../api'
import { Empty, ErrorAlert, PageHeader, useAdminMutation, useAdminQuery } from './common'

const PAGE_SIZE = 25

export default function Products () {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const categories = useAdminQuery('categories.list')
  const list = useAdminQuery('products.list', {
    q, page, pageSize: PAGE_SIZE, category: category === 'all' ? undefined : category, status: status === 'all' ? undefined : status
  }, [q, page, category, status])
  const { mutate } = useAdminMutation()
  const total = list.data?.total || 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const topCategories = (categories.data?.items || []).filter((c) => !c.urlPath.includes('/'))

  const onMenu = async (product, key) => {
    if (key === 'edit') navigate(`/products/${product.sku}`)
    if (key === 'toggle') {
      const next = product.status === 'enabled' ? 'disabled' : 'enabled'
      await mutate('products.setStatus', { sku: product.sku, status: next }, `${product.name} ${next}`)
      list.reload()
    }
    if (key === 'delete') setConfirmDelete(product)
  }

  return (
    <>
      <PageHeader
        title='Products'
        description={`${total} products · prices in AUD (GST inclusive)`}
        actions={<Button variant='accent' onPress={() => navigate('/products/new')}>New product</Button>}
      />
      <Flex gap='size-200' wrap marginBottom='size-200' alignItems='end'>
        <SearchField label='Search' aria-label='Search products by name, SKU or tag' width='size-3600' onSubmit={(v) => { setPage(1); setQ(v) }} onClear={() => { setPage(1); setQ('') }} />
        <Picker label='Category' selectedKey={category} onSelectionChange={(k) => { setPage(1); setCategory(k) }} items={[{ urlPath: 'all', name: 'All categories' }, ...topCategories]}>
          {(c) => <Item key={c.urlPath}>{c.name}</Item>}
        </Picker>
        <Picker label='Status' selectedKey={status} onSelectionChange={(k) => { setPage(1); setStatus(k) }}>
          <Item key='all'>All</Item>
          <Item key='enabled'>Enabled</Item>
          <Item key='disabled'>Disabled</Item>
        </Picker>
      </Flex>
      <ErrorAlert error={list.error} onRetry={list.reload} />
      <TableView
        aria-label='Products'
        density='compact'
        overflowMode='wrap'
        onAction={(key) => navigate(`/products/${key}`)}
        renderEmptyState={() => <Empty title='No products found'>Try a different search or filter.</Empty>}
        minHeight='size-3600'
      >
        <TableHeader>
          <Column key='name' width='2fr'>Product</Column>
          <Column key='sku'>SKU</Column>
          <Column key='status'>Status</Column>
          <Column key='price' align='end'>Price</Column>
          <Column key='stock' align='end'>Stock</Column>
          <Column key='images' align='end'>Images</Column>
          <Column key='actions' width={64}><Text>Actions</Text></Column>
        </TableHeader>
        <TableBody items={list.data?.items || []} loadingState={list.loading ? 'loading' : 'idle'}>
          {(p) => (
            <Row key={p.sku}>
              <Cell>
                <Flex direction='column'>
                  <Text>{p.name}</Text>
                  <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)', fontSize: 12 }}>
                    {p.type === 'configurable' ? `${p.variants} variants` : 'Simple'} · {p.categories?.[0]}
                  </Text>
                </Flex>
              </Cell>
              <Cell>{p.sku}</Cell>
              <Cell>
                <StatusLight variant={p.status === 'enabled' ? 'positive' : 'neutral'}>{p.status === 'enabled' ? 'Enabled' : 'Disabled'}</StatusLight>
              </Cell>
              <Cell>{p.minPrice === p.maxPrice ? formatMoney(p.minPrice) : `${formatMoney(p.minPrice)}–${formatMoney(p.maxPrice)}`}</Cell>
              <Cell>
                <Flex gap='size-100' justifyContent='end' alignItems='center'>
                  {p.outOfStock > 0 && <Badge variant='negative'>{p.outOfStock} out</Badge>}
                  {p.lowStock > 0 && <Badge variant='yellow'>{p.lowStock} low</Badge>}
                  <Text>{p.stock}</Text>
                </Flex>
              </Cell>
              <Cell>{p.images ? p.images : <Badge variant='neutral'>None</Badge>}</Cell>
              <Cell>
                <MenuTrigger>
                  <ActionButton isQuiet aria-label={`Actions for ${p.name}`}><More /></ActionButton>
                  <Menu onAction={(key) => onMenu(p, key)}>
                    <Item key='edit'>Edit</Item>
                    <Item key='toggle'>{p.status === 'enabled' ? 'Disable' : 'Enable'}</Item>
                    <Item key='delete'>Delete…</Item>
                  </Menu>
                </MenuTrigger>
              </Cell>
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
      <DialogContainer onDismiss={() => setConfirmDelete(null)}>
        {confirmDelete && (
          <AlertDialog
            title={`Delete ${confirmDelete.name}?`}
            variant='destructive'
            primaryActionLabel='Delete'
            cancelLabel='Cancel'
            onPrimaryAction={async () => {
              await mutate('products.delete', { sku: confirmDelete.sku }, `${confirmDelete.name} deleted`)
              list.reload()
            }}
          >
            This removes the product, its variants, prices and stock from the demo store. Linked AEM images stay in AEM.
          </AlertDialog>
        )}
      </DialogContainer>
    </>
  )
}
