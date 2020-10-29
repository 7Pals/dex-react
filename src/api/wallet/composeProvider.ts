import RpcEngine, {
  JsonRpcEngine,
  JsonRpcMiddleware,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from 'json-rpc-engine'
import providerFromEngine from 'eth-json-rpc-middleware/providerFromEngine'
import { TransactionConfig } from 'web3-core'
import { numberToHex, hexToNumber } from 'web3-utils'
import { isWalletConnectProvider, Provider } from './providerUtils'
import { logDebug } from 'utils'
import { web3 } from 'api'

import {
  addTxPendingApproval,
  areTxsPendingApproval,
  openWaitForTxApprovalModal,
  removeTxPendingApproval,
} from 'components/OuterModal'

// custom providerAsMiddleware
function providerAsMiddleware(provider: Provider): JsonRpcMiddleware {
  // WalletConnectProvider.sendAsync is web3-provider-engine.sendAsync
  // it doesn't pass payload on to HttpConnection (WalletConnectProvider.http)
  // WalletConnectProvider.send with callback also doesn't
  // need to either strip callback and call 'send'
  // or use 'request', valid only for call requests
  // txs have to go through send(sendAsync) with callback
  if (isWalletConnectProvider(provider)) {
    const methodsToSend = new Set(['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign'])

    return (req, res, _next, end): void => {
      // send request to provider

      if (methodsToSend.has(req.method)) {
        provider.send(req, (err: JsonRpcError<unknown>, providerRes: JsonRpcResponse<unknown>) => {
          // forward any error
          if (err) return end(err)
          // copy provider response onto original response
          Object.assign(res, providerRes)
          end()
        })

        return
      }

      provider.request(req).then((providerRes) => {
        Object.assign(res, providerRes)
        end()
      }, end)
    }
  }

  // MMask provider uses sendAsync
  // WebSocket provider doesn't have sendAsync
  const sendFName = 'sendAsync' in provider ? 'sendAsync' : 'send'

  return (req, res, _next, end): void => {
    // send request to provider

    provider[sendFName](req, (err: JsonRpcError<unknown>, providerRes: JsonRpcResponse<unknown>) => {
      // forward any error
      if (err) return end(err)
      // copy provider response onto original response
      Object.assign(res, providerRes)
      end()
    })
  }
}

// wait 7 sec, for now
const DEFAULT_TX_APPROVAL_TIMEOUT = 7000

const wrapInTimeout = (middleware: JsonRpcMiddleware, timeout = DEFAULT_TX_APPROVAL_TIMEOUT): JsonRpcMiddleware => {
  return (req, res, next, end): void => {
    if (req.method !== 'eth_sendTransaction') {
      return middleware(req, res, next, end)
    }

    let timeoutId: NodeJS.Timeout | null = null

    // new tx pending approval fired
    addTxPendingApproval(req.id)

    timeoutId = setTimeout(async function askOnTimeout() {
      // all txs were approved/rejected in the wallet
      // in-between timeout on the modal close -- reopen
      if (!areTxsPendingApproval()) return
      // new tx waiting for approval
      if (await openWaitForTxApprovalModal()) {
        // if user chose to wait more in Modal
        // or rejected/approved txs in the wallet
        // don't retrigger modal
        if (!areTxsPendingApproval()) return
        // wait some more
        timeoutId = setTimeout(askOnTimeout, timeout)
      } else {
        // modal closed with `No, stop waiting`
        removeTxPendingApproval(req.id)
        // stop waiting
        if (!timeoutId) return // reset in end() call from provider response
        // code 106 -- Timeout
        // https://eth.wiki/json-rpc/json-rpc-error-codes-improvement-proposal#possible-future-error-codes
        end({ message: 'Timeout for transaction approval or rejection', code: 106 })
      }
      // if modal closed
      // either new one will be reopened
      // or tx were rejected/approved in the wallet already
      // or user chose not to wait anymore
    }, timeout)

    const endWithTimeout = (error?: JsonRpcError<unknown>): void => {
      // if tx wasn't already rejected through the modal
      // remove it from pending here
      removeTxPendingApproval(req.id)
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      end(error)
    }

    return middleware(req, res, next, endWithTimeout)
  }
}

const createConditionalMiddleware = <T extends unknown>(
  condition: (req: JsonRpcRequest<T>) => boolean,
  handle: (req: JsonRpcRequest<T>, res: JsonRpcResponse<T>) => boolean | Promise<boolean>, // handled -- true, not --false
): JsonRpcMiddleware => {
  return async (req: JsonRpcRequest<T>, res: JsonRpcResponse<T>, next, end): Promise<void> => {
    // if not condition, skip and got to next middleware
    if (!condition(req)) return next()

    try {
      const isHandled = await handle(req, res)

      // If handled fully, end here
      if (isHandled) return end()

      // Otherwise continue to next middleware
      next()
    } catch (error) {
      end(error)
    }
  }
}

export interface Earmark {
  data: string
  extraGas: number
}

interface ExtraMiddlewareHandlers {
  fetchGasPrice(): Promise<string | undefined>
  earmarkTx(data?: string): Promise<Earmark>
}

export const composeProvider = <T extends Provider>(
  provider: T,
  { fetchGasPrice, earmarkTx }: ExtraMiddlewareHandlers,
): T => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = new (RpcEngine as any)() as JsonRpcEngine

  engine.push(
    createConditionalMiddleware<[]>(
      (req) => req.method === 'eth_gasPrice',
      async (_req, res) => {
        const fetchedPrice = await fetchGasPrice()

        // got price
        if (fetchedPrice) {
          res.result = numberToHex(fetchedPrice)
          // handled
          return true
        }

        // not handled
        return false
      },
    ),
  )

  if (process.env.NODE_ENV === 'development') {
    // hack to be able to use interface as if from a different account
    // read-only of course
    // account will update on the next eth_accounts call
    // normally on new block in a few seconds

    let substituteAccount = ''

    engine.push(
      createConditionalMiddleware(
        (req) => req.method === 'eth_accounts',
        (_req, res) => {
          if (substituteAccount) {
            res.result = [substituteAccount]
            return true
          }

          return false
        },
      ),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).loginAs = (address: string): void => {
      substituteAccount = address
    }
  }

  engine.push(
    createConditionalMiddleware<TransactionConfig[]>(
      (req) => req.method === 'eth_sendTransaction',
      async (req) => {
        const txConfig = req.params?.[0]
        // no parameters, which shouldn't happen
        if (!txConfig) return false

        // tx.data += decode*
        const { data, extraGas } = await earmarkTx(txConfig.data)
        txConfig.data = data

        // if gas is specified tx.gas += cost of decode*
        if (txConfig.gas) {
          const newGas = hexToNumber(txConfig.gas) + extraGas
          txConfig.gas = numberToHex(newGas)
        }

        // don't mark as handled
        // pass modified tx on
        return false
      },
    ),
  )

  engine.push(
    createConditionalMiddleware<TransactionConfig[]>(
      (req) => req.method === 'eth_sendTransaction',
      async (req) => {
        const txConfig = req.params?.[0]
        // no parameters, which shouldn't happen
        if (!txConfig) return false

        if (!txConfig.gas) {
          const gasLimit = await web3.eth.estimateGas(txConfig).catch((error) => {
            console.error('[composeProvider] Error estimating gas, probably failing transaction', txConfig)
            throw error
          })
          logDebug('[composeProvider] No gas Limit. Using estimation ' + gasLimit)
          txConfig.gas = numberToHex(gasLimit)
        } else {
          logDebug('[composeProvider] Gas Limit: ' + txConfig.gas)
        }

        logDebug('[composeProvider] Sending transaction', txConfig)

        // don't mark as handled
        // pass modified tx on
        return false
      },
    ),
  )

  const walletMiddleware = providerAsMiddleware(provider)
  engine.push(wrapInTimeout(walletMiddleware))

  const composedProvider: T = providerFromEngine(engine)

  const providerProxy = new Proxy(composedProvider, {
    get: function (target, prop, receiver): unknown {
      if (prop === 'sendAsync' || prop === 'send') {
        // composedProvider handles it
        return Reflect.get(target, prop, receiver)
      }
      // pretend we don't support provider.request yet
      if (prop === 'request') {
        return undefined
      }
      // MMask or other provider handles it
      return Reflect.get(provider, prop, receiver)
    },
  })

  return providerProxy
}
