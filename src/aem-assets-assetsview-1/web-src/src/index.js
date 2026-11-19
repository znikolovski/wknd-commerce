import 'core-js/stable'
import 'regenerator-runtime/runtime'
import React from 'react'
import ReactDOM from 'react-dom'
import { HashRouter, Route, Routes } from 'react-router-dom'
import Registration from './components/Registration'
import ProductLinks from './components/ProductLinks'

window.React = React

ReactDOM.render(
  <HashRouter>
    <Routes>
      <Route path="/" element={<Registration />} />
      <Route path="/index.html" element={<Registration />} />
      <Route path="/product-links" element={<ProductLinks />} />
    </Routes>
  </HashRouter>,
  document.getElementById('root')
)
