# Market Sentinel — 1Password secret injection template
# Usage: op inject -i secrets.env.tpl -o secrets.env
#
# Create a "Market Sentinel" item in your 1Password vault with a field
# for each key below. Leave fields blank for providers you don't use.
#
# Vault/item path format: op://VAULT_NAME/ITEM_NAME/FIELD_NAME

# AI Council (at least one required)
OPENAI_API_KEY={{ op://Private/Market Sentinel/OPENAI_API_KEY }}
ANTHROPIC_API_KEY={{ op://Private/Market Sentinel/ANTHROPIC_API_KEY }}
GEMINI_API_KEY={{ op://Private/Market Sentinel/GEMINI_API_KEY }}
GROQ_API_KEY={{ op://Private/Market Sentinel/GROQ_API_KEY }}
COHERE_API_KEY={{ op://Private/Market Sentinel/COHERE_API_KEY }}
MISTRAL_API_KEY={{ op://Private/Market Sentinel/MISTRAL_API_KEY }}
DEEPSEEK_API_KEY={{ op://Private/Market Sentinel/DEEPSEEK_API_KEY }}

# Discord bot
DISCORD_BOT_TOKEN={{ op://Private/Market Sentinel/DISCORD_BOT_TOKEN }}
DISCORD_CHANNEL_ID={{ op://Private/Market Sentinel/DISCORD_CHANNEL_ID }}
