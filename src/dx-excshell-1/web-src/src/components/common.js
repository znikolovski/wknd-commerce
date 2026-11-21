import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, Content, Flex, Heading, IllustratedMessage, InlineAlert, ProgressCircle, Text, ToastQueue
} from '@adobe/react-spectrum'
import { callAdmin } from '../api'
import { useShell } from '../shell-context'

/** Runs an admin op on mount/when deps change; returns { data, error, loading, reload }. */
export function useAdminQuery (op, args = {}, deps = [], { endpoint } = {}) {
  const { ims } = useShell()
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const [nonce, setNonce] = useState(0)
  const argsRef = useRef(args)
  argsRef.current = args
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    if (!op) {
      setState({ data: null, error: null, loading: false })
      return undefined
    }
    const controller = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    callAdmin(ims, op, argsRef.current, { signal: controller.signal, endpoint })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState((s) => ({ ...s, error, loading: false }))
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op, ims.token, nonce, ...deps])

  const reload = useCallback(() => {
    if (mounted.current) setNonce((n) => n + 1)
  }, [])
  return { ...state, reload }
}

/** Returns a mutate(op, args, successMessage) helper with pending state and toasts. */
export function useAdminMutation ({ endpoint } = {}) {
  const { ims } = useShell()
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const mutate = useCallback(async (op, args, successMessage) => {
    setPending(true)
    try {
      const result = await callAdmin(ims, op, args, { endpoint })
      if (successMessage) ToastQueue.positive(successMessage, { timeout: 4000 })
      return result
    } catch (e) {
      ToastQueue.negative(e.message, { timeout: 8000 })
      throw e
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [ims])
  return { mutate, pending }
}

export function Loading ({ label = 'Loading' }) {
  return (
    <Flex justifyContent='center' marginY='size-600'>
      <ProgressCircle aria-label={label} isIndeterminate />
    </Flex>
  )
}

export function ErrorAlert ({ error, onRetry, title = 'Something went wrong' }) {
  if (!error) return null
  return (
    <InlineAlert variant='negative' marginY='size-200'>
      <Heading>{title}</Heading>
      <Content>
        <Flex direction='column' gap='size-100' alignItems='start'>
          <Text>{error.message}</Text>
          {onRetry && <Button variant='secondary' onPress={onRetry}>Try again</Button>}
        </Flex>
      </Content>
    </InlineAlert>
  )
}

export function Empty ({ title, children }) {
  return (
    <IllustratedMessage>
      <Heading>{title}</Heading>
      {children && <Content>{children}</Content>}
    </IllustratedMessage>
  )
}

export function PageHeader ({ title, description, actions }) {
  return (
    <Flex justifyContent='space-between' alignItems='end' wrap gap='size-200' marginBottom='size-300'>
      <Flex direction='column'>
        <Heading level={1} margin={0}>{title}</Heading>
        {description && <Text>{description}</Text>}
      </Flex>
      {actions && <Flex gap='size-100' wrap>{actions}</Flex>}
    </Flex>
  )
}
