import React, { useEffect, useState } from 'react'
import { Provider, defaultTheme, Grid, View, ToastContainer } from '@adobe/react-spectrum'
import ErrorBoundary from 'react-error-boundary'
import { HashRouter as Router, Routes, Route, useParams } from 'react-router-dom'
import { ShellProvider } from '../shell-context'
import SideBar from './SideBar'
import Dashboard from './Dashboard'
import Products from './Products'
import ProductEditor from './ProductEditor'
import Inventory from './Inventory'
import Pricing from './Pricing'
import Orders from './Orders'
import OrderDetail from './OrderDetail'
import { Empty } from './common'

function App (props) {
  const [ims, setIms] = useState(props.ims || {})
  const [locale, setLocale] = useState('en-AU')

  useEffect(() => {
    // the shell refreshes tokens and lets users switch org without reloading the app
    props.runtime.on('configuration', ({ imsOrg, imsToken, locale: next }) => {
      setIms((current) => ({ ...current, org: imsOrg || current.org, token: imsToken || current.token }))
      if (next) setLocale(next.replace('_', '-'))
    })
  }, [props.runtime])

  return (
    <ErrorBoundary onError={() => {}} FallbackComponent={Fallback}>
      <ShellProvider runtime={props.runtime} ims={ims}>
        <Router>
          <Provider theme={defaultTheme} colorScheme='light' locale={locale}>
            <Grid
              areas={{ base: ['sidebar', 'content'], M: ['sidebar content'] }}
              columns={{ base: ['1fr'], M: ['220px', '1fr'] }}
              rows={['auto']}
              minHeight='100vh'
            >
              <View gridArea='sidebar' backgroundColor='gray-75' padding='size-250' borderEndWidth='thin' borderColor='gray-300'>
                <SideBar />
              </View>
              <View gridArea='content' padding={{ base: 'size-200', M: 'size-400' }} overflow='auto'>
                <Routes>
                  <Route path='/' element={<Dashboard />} />
                  <Route path='/products' element={<Products />} />
                  <Route path='/products/new' element={<ProductEditor isNew />} />
                  <Route path='/products/:sku' element={<KeyedProductEditor />} />
                  <Route path='/inventory' element={<Inventory />} />
                  <Route path='/pricing' element={<Pricing />} />
                  <Route path='/orders' element={<Orders />} />
                  <Route path='/orders/:number' element={<OrderDetail />} />
                  <Route path='*' element={<Empty title='Page not found'>Use the navigation to choose a section.</Empty>} />
                </Routes>
              </View>
            </Grid>
            <ToastContainer />
          </Provider>
        </Router>
      </ShellProvider>
    </ErrorBoundary>
  )
}

// Remount per product so tabs and form state never leak between products
function KeyedProductEditor () {
  const { sku } = useParams()
  return <ProductEditor key={sku} />
}

function Fallback ({ componentStack, error }) {
  return (
    <React.Fragment>
      <h1 style={{ textAlign: 'center', marginTop: '20px' }}>Something went wrong</h1>
      <pre>{`${error.message}\n${componentStack}`}</pre>
    </React.Fragment>
  )
}

export default App
