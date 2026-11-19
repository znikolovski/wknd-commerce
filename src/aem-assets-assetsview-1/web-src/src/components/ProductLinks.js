import React, { useEffect, useRef, useState } from 'react'
import { attach } from '@adobe/uix-guest'
import {
  ActionButton, Button, Checkbox, CheckboxGroup, Content, defaultTheme, Divider, Flex, Form, Heading,
  IllustratedMessage, InlineAlert, NumberField, ProgressCircle, Provider, SearchField, Text, View
} from '@adobe/react-spectrum'
import Add from '@spectrum-icons/workflow/Add'
import ChevronDown from '@spectrum-icons/workflow/ChevronDown'
import ChevronUp from '@spectrum-icons/workflow/ChevronUp'
import Edit from '@spectrum-icons/workflow/Edit'
import Link from '@spectrum-icons/workflow/Link'
import Refresh from '@spectrum-icons/workflow/Refresh'
import { extensionId } from './Registration'
import { callAssets } from '../api'

const ROLES = [
  ['image', 'Main product image'], ['small_image', 'Product list image'],
  ['thumbnail', 'Thumbnail'], ['swatch_image', 'Color swatch'], ['hero', 'Hero']
]

export default function ProductLinks () {
  const [guest, setGuest] = useState(null)
  const [theme, setTheme] = useState('light')
  const [asset, setAsset] = useState(null)
  const [enabled, setEnabled] = useState(false)
  const [skus, setSkus] = useState([])
  const [roles, setRoles] = useState([])
  const [positions, setPositions] = useState({})
  const [query, setQuery] = useState('')
  const [products, setProducts] = useState({ items: [], total: 0 })
  const [hasSearched, setHasSearched] = useState(false)
  const [editing, setEditing] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState(true)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [warning, setWarning] = useState('')
  const request = useRef(null)
  const searchRequest = useRef(null)
  const mounted = useRef(true)

  function showAsset (data) {
    setAsset(data)
    setEnabled(data.isCommerce)
    setSkus(data.skus)
    setRoles(data.roles)
    setPositions(Object.fromEntries(data.skus.map((sku, index) => [sku, Number(data.positions[index] || data.positions[0] || 1)])))
    setWarning(data.warning || '')
    setEditing(null)
    setSettingsOpen(false)
  }

  async function load (connection) {
    request.current?.abort()
    searchRequest.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setAsset(null)
    setSearching(false)
    setProducts({ items: [], total: 0 })
    setHasSearched(false)
    setQuery('')
    setError('')
    setNotice('')
    try {
      const resource = await connection.host.details.getCurrentResourceInfo()
      const data = await callAssets(connection, 'asset.get', { assetPath: resource.path }, { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      showAsset(data)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setError(error.message)
    } finally {
      if (mounted.current && !controller.signal.aborted) setBusy(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    attach({ id: extensionId }).then(async connection => {
      const info = await connection.host.theme.getThemeInfo()
      if (!mounted.current) return
      setTheme(info.colorScheme)
      setGuest(connection)
      await load(connection)
    }).catch(error => {
      if (mounted.current) { setError(error.message); setBusy(false) }
    })
    return () => {
      mounted.current = false
      request.current?.abort()
      searchRequest.current?.abort()
    }
  }, [])

  async function search () {
    searchRequest.current?.abort()
    const controller = new AbortController()
    searchRequest.current = controller
    setSearching(true)
    setError('')
    try {
      const data = await callAssets(guest, 'products.search', { q: query }, { signal: controller.signal })
      if (mounted.current && !controller.signal.aborted) {
        setProducts(data)
        setHasSearched(true)
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setError(error.message)
    } finally {
      if (mounted.current && !controller.signal.aborted) setSearching(false)
    }
  }

  async function save (event) {
    event.preventDefault()
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    setNotice('')
    setWarning('')
    try {
      const result = await callAssets(guest, 'asset.save', {
        assetPath: asset.path, revision: asset.revision, isCommerce: enabled,
        skus, roles, positions: skus.map(sku => positions[sku] ?? 1)
      }, { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      showAsset(result)
      setNotice('Product links saved.')
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setError(error.message)
    } finally {
      if (mounted.current && !controller.signal.aborted) setBusy(false)
    }
  }

  const extraRoles = roles.filter(role => !ROLES.some(([value]) => value === role))
  const validPositions = skus.every(sku => Number.isInteger(positions[sku] ?? 1) && (positions[sku] ?? 1) >= 1 && (positions[sku] ?? 1) <= 9999)
  const dirty = asset && (enabled !== asset.isCommerce || JSON.stringify(skus) !== JSON.stringify(asset.skus) ||
    JSON.stringify(roles) !== JSON.stringify(asset.roles) ||
    skus.some((sku, index) => (positions[sku] ?? 1) !== Number(asset.positions[index] || asset.positions[0] || 1)))

  function clearSearch () {
    searchRequest.current?.abort()
    setSearching(false)
    setProducts({ items: [], total: 0 })
    setHasSearched(false)
    setQuery('')
  }

  function cancel () {
    clearSearch()
    showAsset(asset)
    setNotice('')
    setError('')
  }

  return (
    <Provider theme={defaultTheme} colorScheme={theme} minHeight="100vh" backgroundColor="gray-50">
      <View paddingX="size-300" paddingY="size-200" borderBottomWidth="thin" borderColor="gray-200">
        <Flex alignItems="center" justifyContent="space-between">
          <Heading level={2} margin={0}>Product links</Heading>
          {guest && <ActionButton isQuiet aria-label="Reload asset" isDisabled={busy || dirty} onPress={() => load(guest)}><Refresh size="S" /></ActionButton>}
        </Flex>
      </View>
      <View padding="size-300">
        <Flex direction="column" gap="size-250">
          {error && <InlineAlert variant="negative"><Heading>Could not update product links</Heading><Content>{error}</Content></InlineAlert>}
          {notice && <View elementType="output" aria-live="polite"><Text>{notice}</Text></View>}
          {warning && <InlineAlert variant="notice"><Heading>Attention required</Heading><Content>{warning}</Content></InlineAlert>}
          {busy && !asset && <ProgressCircle aria-label="Loading product links" isIndeterminate />}
          {asset && (
            <>
              <SearchField aria-label="Find a product or variant" placeholder="Search products" width="100%" value={query} isDisabled={busy}
                onChange={value => { clearSearch(); setQuery(value) }} onSubmit={search} />
              {searching && <ProgressCircle aria-label="Searching products" isIndeterminate />}
              {hasSearched && (
                <View>
                  <Text>{products.total ? `${products.total} results${products.total > products.items.length ? `; showing ${products.items.length}` : ''}` : 'No products found. Try a name or SKU.'}</Text>
                  <Flex direction="column" marginTop="size-150">
                    {products.items.map(product => (
                      <View key={product.sku} paddingY="size-150" borderBottomWidth="thin" borderColor="gray-200">
                        <Flex alignItems="center" gap="size-150">
                          <Flex direction="column" flex minWidth={0}>
                            <Text>{product.name}</Text>
                            <Text>{product.sku}</Text>
                          </Flex>
                          <ActionButton isQuiet aria-label={`Add ${product.sku}`} isDisabled={busy || skus.includes(product.sku)} onPress={() => {
                            if (!skus.length) setEnabled(true)
                            setSkus(current => [...current, product.sku])
                            setPositions(current => ({ ...current, [product.sku]: 1 }))
                            setNotice('')
                            clearSearch()
                          }}><Add size="S" /></ActionButton>
                        </Flex>
                      </View>
                    ))}
                  </Flex>
                </View>
              )}
              <Form onSubmit={save}>
                <Flex direction="column" gap="size-250">
                  {!skus.length
                    ? (
                      <View paddingY="size-600">
                        <IllustratedMessage>
                          <Link size="XXL" />
                          <Heading>No products linked</Heading>
                          <Content>Search for a product to link this asset.</Content>
                        </IllustratedMessage>
                      </View>
                      )
                    : (
                      <Flex direction="column">
                        <Flex alignItems="center" justifyContent="space-between" marginBottom="size-100">
                          <Heading level={3} margin={0}>Linked products ({skus.length})</Heading>
                          {!enabled && <Text>Not used in commerce</Text>}
                        </Flex>
                        {skus.map(sku => (
                          <View key={sku} paddingY="size-200" borderBottomWidth="thin" borderColor="gray-200">
                            <Flex alignItems="center" justifyContent="space-between" gap="size-100">
                              <Flex direction="column" minWidth={0}>
                                <Text>{sku}</Text>
                                <Text>Position {positions[sku] ?? 1}</Text>
                              </Flex>
                              <ActionButton isQuiet aria-label={`Edit ${sku}`} aria-expanded={editing === sku} isDisabled={busy}
                                onPress={() => setEditing(editing === sku ? null : sku)}><Edit size="S" /></ActionButton>
                            </Flex>
                            {editing === sku && (
                              <Flex direction="column" alignItems="start" gap="size-150" marginTop="size-200">
                                <NumberField label="Gallery position" width="100%" minValue={1} maxValue={9999} step={1}
                                  value={positions[sku] ?? 1} isDisabled={busy}
                                  validationState={Number.isInteger(positions[sku]) && positions[sku] >= 1 && positions[sku] <= 9999 ? undefined : 'invalid'}
                                  errorMessage="Enter a whole number from 1 to 9999."
                                  onChange={value => { setPositions(current => ({ ...current, [sku]: value })); setNotice('') }} />
                                <Button variant="negative" isQuiet isDisabled={busy} onPress={() => {
                                  if (skus.length === 1) setEnabled(false)
                                  setSkus(current => current.filter(value => value !== sku))
                                  setEditing(null)
                                  setNotice('')
                                }}>Unlink product</Button>
                              </Flex>
                            )}
                          </View>
                        ))}
                      </Flex>
                      )}
                  {(skus.length > 0 || dirty) && (
                    <Flex direction="column" alignItems="start" gap="size-200">
                      <ActionButton isQuiet aria-expanded={settingsOpen} isDisabled={busy} onPress={() => setSettingsOpen(!settingsOpen)}>
                        {settingsOpen ? <ChevronUp size="S" /> : <ChevronDown size="S" />}<Text>Image settings</Text>
                      </ActionButton>
                      {settingsOpen && (
                        <Flex direction="column" gap="size-200" width="100%">
                          <Checkbox isSelected={enabled} onChange={value => { setEnabled(value); setNotice('') }} isDisabled={busy}>Use in commerce</Checkbox>
                          <CheckboxGroup label="Image roles" description="Applies to all linked products. Leave empty to use gallery-position defaults."
                            value={roles} onChange={value => { setRoles(value); setNotice('') }} isDisabled={busy}>
                            {[...ROLES, ...extraRoles.map(role => [role, role])].map(([value, label]) => <Checkbox key={value} value={value}>{label}</Checkbox>)}
                          </CheckboxGroup>
                          <Text>Turn off Use in commerce and save to unlink all products. Asset approval stays unchanged.</Text>
                        </Flex>
                      )}
                    </Flex>
                  )}
                  <Divider size="S" />
                  <Flex justifyContent="end" gap="size-150">
                    <ActionButton isQuiet isDisabled={busy || !dirty} onPress={cancel}><Text>Cancel</Text></ActionButton>
                    <Button type="submit" variant="accent" isPending={busy} isDisabled={busy || !dirty || (enabled && !skus.length) || !validPositions}>Save</Button>
                  </Flex>
                </Flex>
              </Form>
            </>
          )}
        </Flex>
      </View>
    </Provider>
  )
}
