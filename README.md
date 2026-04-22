# DeepSeek Native Chat for VS Code

Integrate DeepSeek AI as a native language model provider in VS Code using your own API key.

## Quick Installation

### One-Command Installation (Recommended)
```bash
# Clone the repository
git clone https://github.com/your-username/deepseek-native-chat.git
cd deepseek-native-chat

# Run the installation script
./install.sh
```

### Manual Installation
```bash
# Clone the repository
git clone https://github.com/your-username/deepseek-native-chat.git
cd deepseek-native-chat

# Install dependencies and compile
npm install
npm run compile

# Package the extension
npx @vscode/vsce package --allow-missing-repository

# Install the VSIX file
code --install-extension deepseek-native-chat-*.vsix
```

If `code` command is not found:
1. Open VS Code
2. Go to Extensions (Cmd+Shift+X or Ctrl+Shift+X)
3. Click '...' (More Actions) → 'Install from VSIX...'
4. Select the generated `.vsix` file

## Configuration

1. **Get your API key** from [DeepSeek Platform](https://platform.deepseek.com)
2. **Configure in VS Code**:
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type **"Configure DeepSeek API Key"**
   - Enter your API key

Or add to settings.json:
```json
{
  "deepseek.apiKey": "sk-your-api-key-here"
}
```

## Usage

1. Open chat panel (`Cmd+I` on Mac, `Ctrl+I` on Windows/Linux)
2. Click the model selector (shows "Claude", "GPT", etc.)
3. Select **"DeepSeek Chat"** or **"DeepSeek Coder"**
4. Start chatting!

## What This Does

This extension adds DeepSeek as a **native language model provider** in VS Code:
- ✅ DeepSeek appears alongside Claude, GPT in model selector
- ✅ Uses your own DeepSeek API key
- ✅ Streaming responses like native AI
- ✅ Full chat history support
- ✅ Two models: DeepSeek Chat & DeepSeek Coder

## Requirements

- VS Code 1.88.0 or higher
- DeepSeek API key (free tier available)
- Node.js 18+ (for building)
- GitHub Copilot individual plan (for third-party model providers)

## Troubleshooting

### Extension not appearing in model selector?
1. **Restart VS Code** after installation
2. **Check VS Code version** (must be 1.88.0+)
3. **Verify API key** is configured correctly
4. **Check Output panel** (View → Output → "DeepSeek Native Chat")
5. **Ensure GitHub Copilot individual plan** is active

### 'code' command not found?
1. Open VS Code
2. Press `Cmd+Shift+P` → "Shell Command: Install 'code' command in PATH"
3. Or install manually via Extensions → Install from VSIX

### API errors?
- Check your API key is valid and has credits
- Verify network connectivity to DeepSeek API

## Development

```bash
# Install dependencies
npm install

# Watch for changes
npm run watch

# Rebuild
npm run compile

# Test installation
./install.sh
```

## License

MIT
