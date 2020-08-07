import React, { useEffect, useRef } from 'react'
import styled from 'styled-components'

import * as am4core from '@amcharts/amcharts4/core'
import * as am4charts from '@amcharts/amcharts4/charts'

import { dexPriceEstimatorApi } from 'api'

import { getNetworkFromId, safeTokenName, logDebug } from 'utils'

import useSafeState from 'hooks/useSafeState'
import { useOwlAmountInBaseTokenUnits } from 'hooks/useOwlAmountInBaseTokenUnits'

import { TokenDetails, Network } from 'types'

import { ORDER_BOOK_MINIMUM_OWL_VOLUME, ORDER_BOOK_REFRESH_INTERVAL, ORDER_BOOK_ZOOM_INCREMENT_PERCENTAGE } from 'const'

import { Offer, PricePointDetails, ZoomValues } from 'components/OrderBookChart/types'
import { calcInitialZoom, calcZoomY } from 'components/OrderBookChart/zoomFunctions'
import { createChart, getZoomButtonContainer, setLabel } from 'components/OrderBookChart/chartFunctions'
import { processData, _printOrderBook } from 'components/OrderBookChart/dataProcessingFunctions'

const Wrapper = styled.div`
  display: flex;
  justify-content: center;
  /* min-height: 40rem; */
  /* height: calc(100vh - 30rem); */
  min-height: calc(100vh - 30rem);
  text-align: center;
  width: 100%;
  height: 100%;
  min-width: 100%;

  .amcharts-Sprite-group {
    font-size: 1rem;
  }

  .amcharts-Container .amcharts-Label {
    text-transform: uppercase;
    font-size: 1.2rem;
  }

  .amcharts-ZoomOutButton-group > .amcharts-RoundedRectangle-group {
    fill: var(--color-text-active);
    opacity: 0.6;
    transition: 0.3s ease-in-out;

    &:hover {
      opacity: 1;
    }
  }

  .amcharts-AxisLabel,
  .amcharts-CategoryAxis .amcharts-Label-group > .amcharts-Label,
  .amcharts-ValueAxis-group .amcharts-Label-group > .amcharts-Label {
    fill: var(--color-text-primary);
  }
`

interface ChartProps {
  baseToken: TokenDetails
  quoteToken: TokenDetails
  networkId: number
  hops?: number
}

export const Chart: React.FC<ChartProps> = props => {
  const { baseToken, quoteToken, networkId, hops } = props
  const [chart, setChart] = useSafeState<null | am4charts.XYChart>(null)
  const [initialZoom, setInitialZoom] = useSafeState<ZoomValues>({ startX: 0, endX: 1, endY: 1 })
  const [bids, setBids] = useSafeState<PricePointDetails[]>([])
  const [asks, setAsks] = useSafeState<PricePointDetails[]>([])

  // Get the price of X OWL in quote token
  const { amount: amountInOwl, isLoading } = useOwlAmountInBaseTokenUnits(
    ORDER_BOOK_MINIMUM_OWL_VOLUME,
    networkId,
    baseToken,
  )

  const mountPoint = useRef<HTMLDivElement>(null)

  // Creates chart instance upon load
  useEffect(() => {
    if (!mountPoint.current) {
      return
    }

    const _chart = createChart(mountPoint.current)

    setChart(_chart)

    return (): void => _chart.dispose()
    // We'll create only one instance as long as the component is not unmounted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reloads data on token/network change
  // Sets chart configs that depend on token
  // Does the initial zoom calculation
  useEffect(() => {
    if (!chart || isLoading) {
      return
    }

    const baseTokenLabel = safeTokenName(baseToken)
    const quoteTokenLabel = safeTokenName(quoteToken)

    const networkDescription = networkId !== Network.Mainnet ? `${getNetworkFromId(networkId)} ` : ''

    // Axes config
    const xAxis = chart.xAxes.values[0] as am4charts.ValueAxis<am4charts.AxisRenderer>
    xAxis.title.text = `${networkDescription} Price (${quoteTokenLabel})`

    const yAxis = chart.yAxes.values[0] as am4charts.ValueAxis<am4charts.AxisRenderer>
    yAxis.title.text = baseTokenLabel

    // Tool tip
    const market = baseTokenLabel + '-' + quoteTokenLabel

    const [bidSeries, askSeries] = chart.series.values
    bidSeries.tooltipText = `[bold]${market}[/]\nBid Price: [bold]{priceFormatted}[/] ${quoteTokenLabel}\nVolume: [bold]{totalVolumeFormatted}[/] ${baseTokenLabel}`
    askSeries.tooltipText = `[bold]${market}[/]\nAsk Price: [bold]{priceFormatted}[/] ${quoteTokenLabel}\nVolume: [bold]{totalVolumeFormatted}[/] ${baseTokenLabel}`

    // Update data source according to network/base token/quote token
    chart.dataSource.url = dexPriceEstimatorApi.getOrderBookUrl({
      baseTokenId: baseToken.id,
      quoteTokenId: quoteToken.id,
      hops,
      networkId,
    })

    let firstLoad = true

    function adjustZoomOnFirstLoad(zoomValues: ZoomValues): void {
      if (firstLoad) {
        logDebug(`[Order Book] First load for token pair. Adjusting zoom to `, zoomValues)
        xAxis.start = zoomValues.startX
        xAxis.end = zoomValues.endX
        yAxis.end = zoomValues.endY

        firstLoad = false

        // From now on, update the same data to remove flickering
        if (chart) chart.dataSource.updateCurrentData = false
      }
    }

    // Removing any previous event handler
    chart.dataSource.adapter.remove('parsedData')

    // Adding new event handler
    chart.dataSource.adapter.add('parsedData', data => {
      try {
        const bids = processData(data.bids, baseToken, quoteToken, Offer.Bid, amountInOwl)
        const asks = processData(data.asks, baseToken, quoteToken, Offer.Ask, amountInOwl)
        const pricePoints = bids.concat(asks)

        // Store bids and asks for later Y zoom calculation
        setBids(bids)
        setAsks(asks)

        const initialZoom = calcInitialZoom(bids, asks)

        // Zoom in, only if this is the first load of this token pair
        adjustZoomOnFirstLoad(initialZoom)

        // Setting initial zoom
        setInitialZoom(initialZoom)

        _printOrderBook(pricePoints, baseToken, quoteToken)

        return pricePoints
      } catch (error) {
        console.error('Error processing data', error)
        return []
      }
    })

    // Trigger data load re-using same chart
    chart.dataSource.load()

    // First load, do not update current data because it was a different token pair/network
    chart.dataSource.updateCurrentData = false

    // Refresh data automatically
    chart.dataSource.reloadFrequency = ORDER_BOOK_REFRESH_INTERVAL
  }, [baseToken, chart, hops, networkId, quoteToken, amountInOwl, isLoading, setInitialZoom, setBids, setAsks])

  // Creates zoom buttons once initialZoom has been calculated
  useEffect(() => {
    if (!chart) {
      return
    }

    // Finding the container for zoom buttons
    const buttonContainer = getZoomButtonContainer(chart)

    // Data not loaded yet, there's no container
    if (!buttonContainer) {
      return
    }
    buttonContainer.disposeChildren()

    const xAxis = chart.xAxes.values[0] as am4charts.ValueAxis<am4charts.AxisRenderer>
    const yAxis = chart.yAxes.values[0] as am4charts.ValueAxis<am4charts.AxisRenderer>

    // When any of these is not set, there's no data in the chart, thus we don't need to adjust the zoom
    if (!xAxis || xAxis.min === undefined || xAxis.max === undefined || !yAxis || yAxis.max === undefined) {
      return
    }

    const zoomInButton = buttonContainer.createChild(am4core.Button)
    setLabel(zoomInButton.label, '+')
    zoomInButton.events.on('hit', () => {
      // Even though there's a check in the parent context, TS won't shut up unless I put this up
      if (xAxis.min === undefined || xAxis.max === undefined || yAxis.max === undefined) {
        return
      }
      const diff = xAxis.end - xAxis.start
      const delta = diff * ORDER_BOOK_ZOOM_INCREMENT_PERCENTAGE
      xAxis.start += delta
      xAxis.end -= delta

      const endY = calcZoomY(bids, asks, xAxis.min, xAxis.max, xAxis.start, xAxis.end, yAxis.max)
      logDebug(`[Order Book] New zoom boundaries X: ${xAxis.start * 100}% - ${xAxis.end * 100}%; Y ${endY * 100}%`)
      yAxis.end = endY
    })

    const zoomOutButton = buttonContainer.createChild(am4core.Button)
    setLabel(zoomOutButton.label, '-')
    zoomOutButton.events.on('hit', () => {
      if (xAxis.min === undefined || xAxis.max === undefined || yAxis.max === undefined) {
        return
      }
      const diff = xAxis.end - xAxis.start
      const delta = diff * ORDER_BOOK_ZOOM_INCREMENT_PERCENTAGE
      xAxis.start = Math.max(xAxis.start - delta, 0)
      xAxis.end = Math.min(xAxis.end + delta, 1)

      yAxis.end = calcZoomY(bids, asks, xAxis.min, xAxis.max, xAxis.start, xAxis.end, yAxis.max)
      logDebug(`[Order Book] New zoom boundaries X: ${xAxis.start * 100}% - ${xAxis.end * 100}%; Y ${yAxis.end * 100}%`)
    })

    const resetZoomButton = buttonContainer.createChild(am4core.Button)
    setLabel(resetZoomButton.label, 'Reset')
    resetZoomButton.events.on('hit', () => {
      xAxis.start = initialZoom.startX
      xAxis.end = initialZoom.endX
      yAxis.end = initialZoom.endY
      logDebug(`[Order Book] New zoom boundaries X: ${xAxis.start * 100}% - ${xAxis.end * 100}%; Y ${yAxis.end * 100}%`)
    })

    const seeAllButton = buttonContainer.createChild(am4core.Button)
    setLabel(seeAllButton.label, 'full')
    seeAllButton.events.on('hit', () => {
      xAxis.start = 0
      xAxis.end = 1
      yAxis.end = 1
    })
  }, [chart, initialZoom, bids, asks])

  return <Wrapper ref={mountPoint} />
}
