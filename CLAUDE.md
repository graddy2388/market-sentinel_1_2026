# Market Sentinel

AI-powered trading advisor agent with dual-model analysis (Claude + OpenAI).

## Quick Start

```bash
npm install
cp .env.example .env  # Add your API keys
npm run dev -- price BTC
npm run dev -- analyze BTC
npm run dev -- critique "I want to buy 1 BTC at $67,000"
```

## Architecture

- **Data**: Binance WebSocket (crypto), planned Finnhub (stocks), GoldAPI (commodities)
- **Analysis**: Technical indicators via `trading-signals` (RSI, MACD, SMA, EMA, Bollinger, ATR)
- **AI**: Dual-model (OpenAI + Claude) with independent analysis and disagreement detection
- **State**: SQLite via sql.js + drizzle-orm, stored at `~/.market-sentinel/data.db`
- **Interfaces**: CLI (commander), MCP server (stdio), planned Discord bot

## Key Commands

- `npm run dev -- price <symbol>` — Quick price check
- `npm run dev -- analyze <symbol>` — Full analysis with AI
- `npm run dev -- critique "<trade description>"` — Get trade critiqued
- `npm run dev -- watch` / `watch-add` / `watch-remove` — Manage watchlist
- `npm run dev -- portfolio` / `portfolio-add` — Manage positions
- `npm run mcp` — Start MCP server for Claude integration

## MCP Server

Register in Claude Code settings:
```json
{
  "mcpServers": {
    "market-sentinel": {
      "command": "npx",
      "args": ["tsx", "src/interfaces/mcp/server.ts"],
      "cwd": "C:\\Users\\reggi\\projects\\market-sentinel"
    }
  }
}
```

## Code Style

- TypeScript with strict mode
- ESM modules (`"type": "module"`)
- Zod for validation
- No unnecessary abstractions
