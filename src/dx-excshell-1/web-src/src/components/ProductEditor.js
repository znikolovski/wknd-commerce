import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ActionButton, Badge, Button, ButtonGroup, Cell, Checkbox, CheckboxGroup, Column, Content, Flex, Form, Heading, Image, InlineAlert,
  Item, NumberField, Picker, Row, Switch, TableBody, TableHeader, TableView, TabList, TabPanels, Tabs, Text, TextArea, TextField,
  ToastQueue, View, Well
} from '@adobe/react-spectrum'
import ChevronUp from '@spectrum-icons/workflow/ChevronUp'
import ChevronDown from '@spectrum-icons/workflow/ChevronDown'
import Delete from '@spectrum-icons/workflow/Delete'
import { dmRendition, formatDate } from '../api'
import { Empty, ErrorAlert, Loading, PageHeader, useAdminMutation, useAdminQuery } from './common'

const VISIBILITY = ['Catalog, Search', 'Catalog', 'Search', 'Not Visible Individually']
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const skuPart = (s) => slug(s).toUpperCase().slice(0, 12)

const EMPTY_PRODUCT = {
  sku: '',
  name: '',
  urlKey: '',
  status: 'enabled',
  visibility: 'Catalog, Search',
  featured: false,
  categories: [],
  tags: [],
  attributes: {},
  shortDescription: '',
  description: '',
  metaTitle: '',
  metaDescription: '',
  options: [],
  variants: []
}

/** Options are edited as "Title: value, value"; ids are derived and swatches preserved. */
function optionsToText (options = []) {
  return options.map((o) => `${o.title}: ${o.values.map((v) => v.title).join(', ')}`).join('\n')
}

function textToOptions (text, previous = []) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [title, values = ''] = line.split(/:(.*)/s)
    const id = slug(title)
    const prev = previous.find((o) => o.id === id)
    return {
      id,
      title: title.trim(),
      values: values.split(',').map((v) => v.trim()).filter(Boolean).map((v) => {
        const vid = slug(v)
        const old = prev?.values.find((x) => x.id === vid)
        return { id: vid, title: v, ...(old?.swatch ? { swatch: old.swatch } : {}) }
      })
    }
  }).filter((o) => o.id && o.values.length)
}

/** Cartesian product of option values, keeping existing variant SKUs for unchanged selections. */
function buildVariants (sku, options, existing = []) {
  if (!options.length) return []
  let combos = [{}]
  options.forEach((o) => {
    combos = combos.flatMap((c) => o.values.map((v) => ({ ...c, [o.id]: v.id })))
  })
  return combos.map((selections) => {
    const match = existing.find((v) => options.every((o) => v.selections?.[o.id] === selections[o.id]))
    return match || { sku: [sku, ...options.map((o) => skuPart(selections[o.id]))].join('-'), selections }
  })
}

function attributesToText (attrs = {}) {
  return Object.entries(attrs).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')
}

function textToAttributes (text) {
  return Object.fromEntries(text.split('\n').map((l) => l.split(/:(.*)/s)).filter(([k, v]) => k?.trim() && v !== undefined)
    .map(([k, v]) => [k.trim(), Number.isFinite(Number(v)) && v.trim() !== '' && !/^0\d/.test(v.trim()) ? Number(v) : v.trim()]))
}

export default function ProductEditor ({ isNew = false }) {
  const { sku: routeSku } = useParams()
  const navigate = useNavigate()
  const categories = useAdminQuery('categories.list')
  const detail = useAdminQuery(isNew ? null : 'products.get', { sku: routeSku }, [routeSku, isNew])
  const { mutate, pending } = useAdminMutation()

  const [product, setProduct] = useState(EMPTY_PRODUCT)
  const [optionsText, setOptionsText] = useState('')
  const [attributesText, setAttributesText] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [basePrice, setBasePrice] = useState(0)
  const [rows, setRows] = useState({})
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (isNew || !detail.data?.product) return
    const p = detail.data.product
    setProduct({ ...EMPTY_PRODUCT, ...p })
    setOptionsText(optionsToText(p.options))
    setAttributesText(attributesToText(p.attributes))
    setTagsText((p.tags || []).join(', '))
    const priceBySku = Object.fromEntries((detail.data.prices || []).map((x) => [x.sku, x]))
    const stockBySku = Object.fromEntries((detail.data.inventory || []).map((x) => [x.sku, x]))
    setBasePrice(priceBySku[p.sku]?.regular ?? 0)
    const sellable = p.type === 'configurable' ? p.variants.map((v) => v.sku) : [p.sku]
    setRows(Object.fromEntries(sellable.map((s) => [s, {
      regular: priceBySku[s]?.regular ?? priceBySku[p.sku]?.regular ?? 0,
      special: priceBySku[s]?.special ?? null,
      qty: stockBySku[s]?.qty ?? 0,
      lowStockThreshold: stockBySku[s]?.lowStockThreshold ?? 3,
      original: { price: priceBySku[s], stock: stockBySku[s] }
    }])))
  }, [detail.data, isNew])

  const set = (patch) => setProduct((p) => ({ ...p, ...patch }))
  const options = useMemo(() => textToOptions(optionsText, product.options), [optionsText, product.options])
  const variants = useMemo(() => buildVariants(product.sku.toUpperCase(), options, product.variants), [product.sku, options, product.variants])
  const variantColumns = [{ key: 'sku', name: 'Variant SKU' }, ...options.map((o) => ({ key: `opt:${o.id}`, name: o.title })), { key: 'state', name: 'State' }]
  const variantRows = variants.map((v) => ({
    key: v.sku,
    sku: v.sku,
    isNew: !(product.variants || []).some((x) => x.sku === v.sku),
    state: 'Existing',
    ...Object.fromEntries(options.map((o) => [`opt:${o.id}`, o.values.find((x) => x.id === v.selections[o.id])?.title || '']))
  }))
  const leafCategories = (categories.data?.items || []).filter((c) => c.urlPath.includes('/') || !(categories.data.items || []).some((x) => x.urlPath.startsWith(`${c.urlPath}/`)))
  const invalid = {
    sku: !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(product.sku.toUpperCase()),
    name: !product.name.trim(),
    categories: !product.categories.length
  }
  const canSave = !invalid.sku && !invalid.name && !invalid.categories

  const payload = () => ({
    ...product,
    sku: product.sku.toUpperCase(),
    urlKey: product.urlKey || slug(product.name),
    tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
    attributes: textToAttributes(attributesText),
    options,
    variants,
    ...(isNew ? { price: basePrice } : {})
  })

  const save = async () => {
    setTouched(true)
    if (!canSave) return
    const result = await mutate(isNew ? 'products.create' : 'products.save', { product: payload() },
      isNew ? 'Product created' : 'Product saved — PDP will re-render shortly')
    if (isNew) navigate(`/products/${result.product.sku}`, { replace: true })
    else detail.reload()
  }

  const savePricesAndStock = async () => {
    const entries = Object.entries(rows)
    const prices = entries.filter(([, r]) => r.regular !== r.original.price?.regular || (r.special ?? null) !== (r.original.price?.special ?? null))
      .map(([s, r]) => ({ sku: s, regular: r.regular, special: r.special || null }))
    const stock = entries.filter(([, r]) => r.qty !== r.original.stock?.qty || r.lowStockThreshold !== r.original.stock?.lowStockThreshold)
      .map(([s, r]) => ({ sku: s, qty: r.qty, lowStockThreshold: r.lowStockThreshold }))
    if (!prices.length && !stock.length) return
    if (prices.length) await mutate('prices.update', { items: prices })
    if (stock.length) await mutate('inventory.update', { items: stock })
    ToastQueue.positive(`Updated ${prices.length} price(s) and ${stock.length} stock level(s)`, { timeout: 4000 })
    detail.reload()
  }

  if (!isNew && detail.loading && !detail.data) return <Loading label='Loading product' />
  if (!isNew && detail.error) return <ErrorAlert error={detail.error} onRetry={detail.reload} title='Could not load product' />

  const images = isNew ? [] : (detail.data?.images || [])

  return (
    <>
      <PageHeader
        title={isNew ? 'New product' : product.name || routeSku}
        description={isNew ? 'Create a simple or configurable product.' : `${product.sku} · updated ${formatDate(product.updatedAt)}`}
        actions={(
          <ButtonGroup>
            <Button variant='secondary' onPress={() => navigate('/products')}>Back to products</Button>
            {!isNew && product.urlKey && (
              <Button variant='secondary' elementType='a' href={`https://wknd-adventures.run.place/shop/products/${product.urlKey}`} target='_blank'>View on site</Button>
            )}
            <Button variant='accent' onPress={save} isPending={pending}>{isNew ? 'Create product' : 'Save product'}</Button>
          </ButtonGroup>
        )}
      />
      {touched && !canSave && (
        <InlineAlert variant='negative' marginBottom='size-200'>
          <Heading>Check the highlighted fields</Heading>
          <Content>SKU, name and at least one category are required.</Content>
        </InlineAlert>
      )}
      <Tabs aria-label='Product sections'>
        <TabList>
          <Item key='details'>Details</Item>
          <Item key='options'>Options &amp; variants</Item>
          <Item key='pricing'>{isNew ? 'Price' : 'Price & stock'}</Item>
          <Item key='images'>Images</Item>
        </TabList>
        <TabPanels>
          <Item key='details'>
            <Form maxWidth='size-6000' marginTop='size-200' validationBehavior='aria' onSubmit={(e) => { e.preventDefault(); save() }}>
              <TextField label='Name' isRequired value={product.name} onChange={(name) => set({ name, ...(isNew ? { urlKey: slug(name) } : {}) })}
                validationState={touched && invalid.name ? 'invalid' : undefined} errorMessage='Enter a product name' />
              <TextField label='SKU' isRequired isReadOnly={!isNew} value={product.sku} onChange={(sku) => set({ sku: sku.toUpperCase() })}
                description='A–Z, 0–9 and hyphens. Variant SKUs extend this.' validationState={touched && invalid.sku ? 'invalid' : undefined}
                errorMessage='3–64 characters: A–Z, 0–9 and hyphens' />
              <TextField label='URL key' value={product.urlKey} onChange={(urlKey) => set({ urlKey: slug(urlKey) })} description={`/shop/products/${product.urlKey || slug(product.name)}`} />
              <Flex gap='size-300' wrap>
                <Switch isSelected={product.status === 'enabled'} onChange={(on) => set({ status: on ? 'enabled' : 'disabled' })}>Enabled</Switch>
                <Switch isSelected={product.featured} onChange={(featured) => set({ featured })}>Featured</Switch>
              </Flex>
              <Picker label='Visibility' selectedKey={product.visibility} onSelectionChange={(visibility) => set({ visibility })}>
                {VISIBILITY.map((v) => <Item key={v}>{v}</Item>)}
              </Picker>
              <CheckboxGroup label='Categories' isRequired value={product.categories} onChange={(cats) => set({ categories: cats })}
                validationState={touched && invalid.categories ? 'invalid' : undefined} errorMessage='Choose at least one category'>
                {leafCategories.map((c) => <Checkbox key={c.urlPath} value={c.urlPath}>{c.urlPath.replace(/\//g, ' › ')}</Checkbox>)}
              </CheckboxGroup>
              <TextField label='Adventure tags' value={tagsText} onChange={setTagsText} description='Comma-separated, e.g. patagonia-trek, trekking (used for search facets and OF1 gear recommendations)' />
              <TextArea label='Short description' value={product.shortDescription} onChange={(shortDescription) => set({ shortDescription })} />
              <TextArea label='Description (HTML)' value={product.description} onChange={(description) => set({ description })} height='size-2400' />
              <TextArea label='Attributes' value={attributesText} onChange={setAttributesText} description='One per line: Name: value (shown in the PDP details table)' />
              <TextField label='Meta title' value={product.metaTitle} onChange={(metaTitle) => set({ metaTitle })} />
              <TextArea label='Meta description' value={product.metaDescription} onChange={(metaDescription) => set({ metaDescription })} />
            </Form>
          </Item>
          <Item key='options'>
            <View marginTop='size-200' maxWidth='size-6000'>
              <TextArea label='Options' width='100%' value={optionsText} onChange={setOptionsText}
                description='One option per line, e.g. "Colour: Ember Red, Glacier Blue" and "Size: S, M, L". Leave empty for a simple product.' />
              <Text UNSAFE_style={{ display: 'block', marginTop: 12 }}>
                {options.length ? `Configurable · ${variants.length} variants` : 'Simple product'}
                {!isNew && product.type === 'configurable' && !options.length ? ' — saving will convert this to a simple product.' : ''}
              </Text>
            </View>
            {variants.length > 0 && (
              <TableView aria-label='Variants' density='compact' marginTop='size-200' maxHeight='size-6000'>
                <TableHeader columns={variantColumns}>
                  {(c) => <Column key={c.key}>{c.name}</Column>}
                </TableHeader>
                <TableBody items={variantRows}>
                  {(item) => (
                    <Row key={item.key}>
                      {(columnKey) => (
                        <Cell>{columnKey === 'state' && item.isNew ? <Badge variant='info'>New</Badge> : item[columnKey]}</Cell>
                      )}
                    </Row>
                  )}
                </TableBody>
              </TableView>
            )}
            <Text UNSAFE_style={{ display: 'block', marginTop: 12 }}>New variants start with the parent price and zero stock. Save the product to apply.</Text>
          </Item>
          <Item key='pricing'>
            {isNew ? (
              <Form maxWidth='size-3600' marginTop='size-200'>
                <NumberField label='Price (AUD, GST incl.)' minValue={0} value={basePrice} onChange={setBasePrice} formatOptions={{ style: 'currency', currency: 'AUD' }} />
                <Text>Stock starts at zero — set it on the Inventory page after creating the product.</Text>
              </Form>
            ) : (
              <>
                <TableView aria-label='Prices and stock per sellable SKU' density='compact' marginTop='size-200' overflowMode='wrap'>
                  <TableHeader>
                    <Column key='sku'>SKU</Column>
                    <Column key='regular' width={170}>Regular (AUD)</Column>
                    <Column key='special' width={170}>Sale price (AUD)</Column>
                    <Column key='qty' width={130}>Stock</Column>
                    <Column key='low' width={130}>Low-stock at</Column>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(rows).map(([s, r]) => (
                      <Row key={s}>
                        <Cell>{s}</Cell>
                        <Cell><NumberField aria-label={`Regular price for ${s}`} isQuiet minValue={0} value={r.regular} formatOptions={{ minimumFractionDigits: 2 }} onChange={(v) => setRows({ ...rows, [s]: { ...r, regular: v } })} /></Cell>
                        <Cell><NumberField aria-label={`Sale price for ${s}`} isQuiet minValue={0} value={r.special ?? NaN} formatOptions={{ minimumFractionDigits: 2 }} onChange={(v) => setRows({ ...rows, [s]: { ...r, special: Number.isFinite(v) && v > 0 ? v : null } })} /></Cell>
                        <Cell><NumberField aria-label={`Stock for ${s}`} isQuiet minValue={0} step={1} value={r.qty} onChange={(v) => setRows({ ...rows, [s]: { ...r, qty: Math.floor(v || 0) } })} /></Cell>
                        <Cell><NumberField aria-label={`Low-stock threshold for ${s}`} isQuiet minValue={0} step={1} value={r.lowStockThreshold} onChange={(v) => setRows({ ...rows, [s]: { ...r, lowStockThreshold: Math.floor(v || 0) } })} /></Cell>
                      </Row>
                    ))}
                  </TableBody>
                </TableView>
                <Flex marginTop='size-200' gap='size-200' alignItems='center'>
                  <Button variant='accent' onPress={savePricesAndStock} isPending={pending}>Save prices &amp; stock</Button>
                  <Text>Leave the sale price empty for no sale. Bulk sales live on the Pricing page.</Text>
                </Flex>
              </>
            )}
          </Item>
          <Item key='images'>
            <ImagesPanel sku={product.sku} images={images} isNew={isNew} onChange={detail.reload} />
          </Item>
        </TabPanels>
      </Tabs>
    </>
  )
}

function ImagesPanel ({ sku, images, isNew, onChange }) {
  const { mutate, pending } = useAdminMutation()
  if (isNew) return <Empty title='Save the product first'>Images are linked automatically from AEM Assets once the product exists.</Empty>
  const bySku = images.reduce((acc, img) => ({ ...acc, [img.sku]: [...(acc[img.sku] || []), img] }), {})
  const move = async (list, index, delta) => {
    const ids = list.map((i) => i.assetId)
    const [moved] = ids.splice(index, 1)
    ids.splice(index + delta, 0, moved)
    await mutate('images.reorder', { sku: list[0].sku, assetIds: ids }, 'Image order updated')
    onChange()
  }
  return (
    <View marginTop='size-200'>
      <Well>
        Images are linked automatically: assets in <code>/content/dam/wknd-adventures/products</code> with <code>commerce:skus</code> metadata are matched by the
        App Builder asset matcher (AEM Assets events + nightly reconcile) and delivered through Dynamic Media OpenAPI.
      </Well>
      <ButtonGroup marginY='size-200'>
        <Button variant='secondary' isPending={pending} onPress={async () => { await mutate('images.rematch', { skus: [sku] }, 'Re-matched images from AEM'); onChange() }}>Re-match from AEM</Button>
      </ButtonGroup>
      {!images.length && <Empty title='No linked images'>Upload images to AEM with <code>commerce:skus</code> = {sku}, then re-match.</Empty>}
      {Object.entries(bySku).map(([s, list]) => (
        <View key={s} marginBottom='size-300'>
          <Heading level={3}>{s}</Heading>
          <Flex gap='size-200' wrap>
            {list.map((img, i) => (
              <View key={img.assetId} width='size-2000' borderWidth='thin' borderColor='gray-300' borderRadius='medium' padding='size-100'>
                <Image src={dmRendition(img)} alt={img.label || img.name || ''} objectFit='cover' height='size-2400' />
                <Text UNSAFE_style={{ display: 'block', fontSize: 12, wordBreak: 'break-all' }}>{img.name}</Text>
                <Flex gap='size-50' wrap marginY='size-50'>
                  {(img.roles || []).map((r) => <Badge key={r} variant='neutral'>{r}</Badge>)}
                </Flex>
                <Flex gap='size-50'>
                  <ActionButton isQuiet aria-label={`Move ${img.name} earlier`} isDisabled={i === 0 || pending} onPress={() => move(list, i, -1)}><ChevronUp /></ActionButton>
                  <ActionButton isQuiet aria-label={`Move ${img.name} later`} isDisabled={i === list.length - 1 || pending} onPress={() => move(list, i, 1)}><ChevronDown /></ActionButton>
                  <ActionButton isQuiet aria-label={`Unlink ${img.name}`} isDisabled={pending} onPress={async () => { await mutate('images.unlink', { sku: img.sku, assetId: img.assetId }, 'Image unlinked (local override)'); onChange() }}><Delete /></ActionButton>
                </Flex>
              </View>
            ))}
          </Flex>
        </View>
      ))}
    </View>
  )
}
