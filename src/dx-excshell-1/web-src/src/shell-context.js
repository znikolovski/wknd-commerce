import React, { createContext, useContext } from 'react'

export const ShellContext = createContext({ runtime: null, ims: {} })
export const useShell = () => useContext(ShellContext)

export function ShellProvider ({ runtime, ims, children }) {
  return <ShellContext.Provider value={{ runtime, ims }}>{children}</ShellContext.Provider>
}
