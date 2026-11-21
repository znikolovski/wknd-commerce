import React from 'react'
import { NavLink } from 'react-router-dom'
import { Flex, Heading, Text, View } from '@adobe/react-spectrum'

const LINKS = [
  ['/', 'Dashboard'],
  ['/products', 'Products'],
  ['/inventory', 'Inventory'],
  ['/pricing', 'Pricing'],
  ['/promotions', 'Promotions'],
  ['/orders', 'Orders']
]

function SideBar () {
  return (
    <nav aria-label='WKND Commerce'>
      <View marginBottom='size-300'>
        <Heading level={2} margin={0}>WKND Commerce</Heading>
        <Text>Demo store admin</Text>
      </View>
      <Flex direction='column' gap='size-50'>
        {LINKS.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `SideNav-itemLink${isActive ? ' is-selected' : ''}`}>
            {label}
          </NavLink>
        ))}
      </Flex>
    </nav>
  )
}

export default SideBar
