import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { Hyperliquid } from 'hyperliquid';

dotenv.config();

// ==========================================
// ⚡ 策略配置 (1分钟极速版 + 完整看板)
// ==========================================
const CONFIG = {
  ASSETS: [
    { symbol: "BTC", weight: 0.4 },
    { symbol: "ETH", weight: 0.3 },
    { symbol: "SOL", weight: 0.3 }
  ],
  leverage: 5,           // 5倍杠杆 (高风险高回报)
  checkInterval: 5000,   // 5秒刷新一次
  
  // K线周期
  timeframe: '1m',       // 1分钟K线
  
  // 核心指标 (EMA + RSI)
  emaFast: 7,            // 快线
  emaSlow: 21,           // 慢线
  rsiPeriod: 6,          // 敏感RSI

  // 止盈止损 (百分比)
  stopLossPct: 0.004,    // 0.4% 止损
  takeProfitPct: 0.008,  // 0.8% 止盈
  
  ENABLE_LIVE_TRADING: process.env.ENABLE_LIVE_TRADING === 'TRUE'
};

// ==========================================
// 🔐 初始化
// ==========================================
const PRIVATE_KEY = process.env.HYPERLIQUID_PRIVATE_KEY;
const USER_ADDRESS = process.env.PUBLIC_ADDRESS;

if (!PRIVATE_KEY || !USER_ADDRESS) {
  console.error("❌ 错误: 请配置 .env");
  process.exit(1);
}

let sdk: any = null;
if (CONFIG.ENABLE_LIVE_TRADING) {
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  sdk = new Hyperliquid(wallet);
}

// 状态管理
interface PositionState {
  symbol: string;
  position: 'LONG' | 'SHORT' | 'NONE';
  entryPrice: number;
  size: number;
}
const globalState: Record<string, PositionState> = {};
let simBalance = 1000; // 模拟初始资金

CONFIG.ASSETS.forEach(a => {
  globalState[a.symbol] = { symbol: a.symbol, position: 'NONE', entryPrice: 0, size: 0 };
});

// ==========================================
// 🧮 指标算法
// ==========================================

// 计算 EMA (指数移动平均)
function calculateEMA(data: number[], period: number): number {
  if (data.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

// 计算 RSI
function calculateRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains / losses)));
}

async function getCandles(symbol: string): Promise<any[]> {
  try {
    const endTime = Date.now();
    const startTime = endTime - (1000 * 60 * 60); // 过去1小时数据足矣
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: symbol, interval: CONFIG.timeframe, startTime, endTime } })
    });
    return await res.json();
  } catch (e) { return []; }
}

async function getBalance(): Promise<number> {
  if (!CONFIG.ENABLE_LIVE_TRADING) return simBalance;
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: USER_ADDRESS })
    });
    const data: any = await res.json();
    return parseFloat(data.marginSummary.accountValue);
  } catch (e) { return 0; }
}

// ==========================================
// ⚔️ 交易执行
// ==========================================
async function executeTrade(symbol: string, action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE', price: number, reason: string) {
  const state = globalState[symbol];
  const balance = await getBalance();
  const assetCfg = CONFIG.ASSETS.find(a => a.symbol === symbol)!;

  let size = 0;
  if (action === 'CLOSE') {
    size = state.size;
  } else {
    // 动态计算仓位
    const investUsd = balance * assetCfg.weight * CONFIG.leverage;
    size = parseFloat((investUsd / price).toFixed(4));
  }

  console.log(`\n⚡ [${symbol}] 信号触发: ${action} | 价格: $${price} | 数量: ${size} | 原因: ${reason}`);

  if (!CONFIG.ENABLE_LIVE_TRADING) {
    if (action === 'CLOSE') {
      let pnl = 0;
      if (state.position === 'LONG') pnl = (price - state.entryPrice) * size;
      if (state.position === 'SHORT') pnl = (state.entryPrice - price) * size;
      simBalance += pnl;
      // 模拟状态重置
      state.position = 'NONE'; state.size = 0; state.entryPrice = 0;
    } else {
      state.position = (action === 'OPEN_LONG') ? 'LONG' : 'SHORT';
      state.entryPrice = price; state.size = size;
    }
    return;
  }

  // 实盘 API
  try {
    const isBuy = action === 'OPEN_LONG' || (action === 'CLOSE' && state.position === 'SHORT');
    await sdk.exchange.placeOrder({
        coin: symbol, is_buy: isBuy, sz: size,
        limit_px: price * (isBuy ? 1.05 : 0.95), // 激进滑点
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: action === 'CLOSE'
    });
    
    // 简单假设成交更新状态
    if (action === 'CLOSE') {
       state.position = 'NONE'; state.size = 0; state.entryPrice = 0;
    } else {
       state.position = (action === 'OPEN_LONG') ? 'LONG' : 'SHORT';
       state.entryPrice = price; state.size = size;
    }
  } catch (e) { console.error("❌ 下单失败", e); }
}

// ==========================================
// 🤖 主循环 (带详细看板)
// ==========================================
async function runTick() {
  const balance = await getBalance();
  
  // 1. 获取所有K线并计算当前价格，用于展示面板
  const marketData: any[] = [];
  let totalUnrealizedPnL = 0;

  for (const asset of CONFIG.ASSETS) {
    const candles = await getCandles(asset.symbol);
    if (candles.length < 30) continue;
    
    const closes = candles.map((c:any) => parseFloat(c.c));
    const currentPrice = closes[closes.length - 1];
    
    // 计算指标
    const emaFast = calculateEMA(closes, CONFIG.emaFast);
    const emaSlow = calculateEMA(closes, CONFIG.emaSlow);
    const rsi = calculateRSI(closes, CONFIG.rsiPeriod);

    // 计算浮盈
    const state = globalState[asset.symbol];
    let pnl = 0;
    if (state.position !== 'NONE') {
      if (state.position === 'LONG') pnl = (currentPrice - state.entryPrice) * state.size;
      if (state.position === 'SHORT') pnl = (state.entryPrice - currentPrice) * state.size;
    }
    totalUnrealizedPnL += pnl;

    marketData.push({ 
      symbol: asset.symbol, price: currentPrice, 
      emaFast, emaSlow, rsi, pnl, state, closes 
    });
  }

  // 2. 打印仪表盘
  const equity = balance + totalUnrealizedPnL;
  console.log(`\n========== ⚡ 1分钟极速战报 [${new Date().toLocaleTimeString()}] ==========`);
  console.log(`💰 余额: $${balance.toFixed(2)} | 🌊 浮动盈亏: ${totalUnrealizedPnL>=0?'+':''}${totalUnrealizedPnL.toFixed(2)} | 💎 账户净值: $${equity.toFixed(2)}`);
  console.log(`-----------------------------------------------------------------------`);

  // 3. 遍历资产，打印详情并执行策略
  for (const data of marketData) {
    const { symbol, price, emaFast, emaSlow, rsi, pnl, state, closes } = data;
    
    // 状态字符串
    let posStr = `[空仓]`;
    let pnlStr = ``;
    if (state.position !== 'NONE') {
       posStr = `[${state.position === 'LONG'?'多':'空'} ${state.size}] @${state.entryPrice.toFixed(2)}`;
       pnlStr = `| 浮盈: ${pnl>=0?'+':''}${pnl.toFixed(2)}`;
    }

    console.log(` ${symbol.padEnd(4)} $${price.toFixed(2).padEnd(9)} | EMA(${CONFIG.emaFast}/${CONFIG.emaSlow}): ${emaFast.toFixed(1)}/${emaSlow.toFixed(1)} | RSI:${rsi.toFixed(1)} ${posStr} ${pnlStr}`);

    // --- 策略逻辑 ---

    // A. 止盈止损 (最高优先级)
    if (state.position !== 'NONE') {
        let pnlPct = 0;
        if (state.position === 'LONG') pnlPct = (price - state.entryPrice) / state.entryPrice;
        if (state.position === 'SHORT') pnlPct = (state.entryPrice - price) / state.entryPrice;
        
        // 打印 ROE
        // console.log(`    ↳ ROE: ${(pnlPct * CONFIG.leverage * 100).toFixed(2)}%`);

        if (pnlPct <= -CONFIG.stopLossPct) {
            await executeTrade(symbol, 'CLOSE', price, `🛑 止损平仓 (${(pnlPct*100).toFixed(2)}%)`);
            continue;
        }
        if (pnlPct >= CONFIG.takeProfitPct) {
            await executeTrade(symbol, 'CLOSE', price, `🍬 止盈落袋 (${(pnlPct*100).toFixed(2)}%)`);
            continue;
        }
    }

    // B. 开仓信号
    // 金叉: 快线 > 慢线 且 RSI在 50-85 之间 (强势但不至于极度超买)
    const isBullish = emaFast > emaSlow && rsi > 50 && rsi < 85;
    // 死叉: 快线 < 慢线 且 RSI在 15-50 之间 (弱势但不至于极度超卖)
    const isBearish = emaFast < emaSlow && rsi < 50 && rsi > 15;

    if (state.position === 'NONE') {
        if (isBullish) {
             await executeTrade(symbol, 'OPEN_LONG', price, `🚀 极速金叉 RSI:${rsi.toFixed(1)}`);
        } else if (isBearish) {
             await executeTrade(symbol, 'OPEN_SHORT', price, `📉 极速死叉 RSI:${rsi.toFixed(1)}`);
        }
    } 
    // C. 反转信号 (手上有单子，但趋势变了)
    else if (state.position === 'LONG' && emaFast < emaSlow) {
        await executeTrade(symbol, 'CLOSE', price, `🔄 趋势反转(变空)`);
    }
    else if (state.position === 'SHORT' && emaFast > emaSlow) {
        await executeTrade(symbol, 'CLOSE', price, `🔄 趋势反转(变多)`);
    }
  }
}

console.log("🔥 极速短线策略 (Dashboard版) 启动中...");
setInterval(runTick, CONFIG.checkInterval);