import React, { useEffect, useState } from 'react'
import { register } from '@adobe/uix-guest'
import { Content, defaultTheme, Heading, InlineAlert, Provider, Text } from '@adobe/react-spectrum'

export const extensionId = 'wknd-commerce-product-links'

export default function Registration () {
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    register({
      id: extensionId,
      methods: {
        detailSidePanel: {
          getPanels: () => [{
            id: 'wknd-commerce-products', title: 'WKND Commerce',
            tooltip: 'Link products to this asset', icon: 'ShoppingCart',
            contentUrl: '/assets.html#/product-links', reloadOnThemeChange: true
          }]
        }
      }
    }).catch(error => {
      console.error('WKND Commerce Assets registration failed', error)
      if (active) setError(error.message)
    })
    return () => { active = false }
  }, [])
  return (
    <Provider theme={defaultTheme}>
      {error
        ? <InlineAlert variant="negative"><Heading>Could not register WKND Commerce</Heading><Content>{error}</Content></InlineAlert>
        : <Text>Connecting to AEM Assets...</Text>}
    </Provider>
  )
}
