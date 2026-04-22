#!/bin/bash

# DeepSeek Native Chat Installation Script
# This script installs the DeepSeek Native Chat extension for VS Code

set -e

echo "🚀 Installing DeepSeek Native Chat extension..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the extension directory."
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Compile the extension
echo "🔨 Compiling extension..."
npm run compile

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "📦 Installing vsce (VS Code Extension Manager)..."
    npm install -g @vscode/vsce
fi

# Package the extension
echo "📦 Packaging extension..."
vsce package --allow-missing-repository

# Find the VSIX file
VSIX_FILE=$(ls deepseek-native-chat-*.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo "❌ Error: Could not find VSIX file."
    exit 1
fi

echo "📦 Found VSIX file: $VSIX_FILE"

# Try to install using code command
if command -v code &> /dev/null; then
    echo "📥 Installing extension using 'code' command..."
    code --install-extension "$VSIX_FILE"
    echo "✅ Extension installed successfully!"
    echo ""
    echo "📝 Next steps:"
    echo "1. Restart VS Code"
    echo "2. Configure your API key:"
    echo "   - Press Cmd+Shift+P (Mac) or Ctrl+Shift+P (Windows/Linux)"
    echo "   - Type 'Configure DeepSeek API Key'"
    echo "   - Enter your DeepSeek API key"
    echo "3. Open chat (Cmd+I or Ctrl+I) and select DeepSeek models"
else
    echo "⚠️  'code' command not found in PATH."
    echo ""
    echo "📝 Manual installation required:"
    echo "1. Open VS Code"
    echo "2. Go to Extensions (Cmd+Shift+X or Ctrl+Shift+X)"
    echo "3. Click '...' (More Actions) → 'Install from VSIX...'"
    echo "4. Select: $VSIX_FILE"
    echo "5. Restart VS Code and configure your API key"
fi

echo ""
echo "🎉 Installation complete!"
