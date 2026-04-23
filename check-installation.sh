#!/bin/bash

echo "🔍 Checking Universal LLM Extension Installation"
echo "=============================================="

# Check if extension is installed
if command -v code &> /dev/null; then
    echo "✅ VSCode CLI found"
    
    # List extensions
    EXTENSIONS=$(code --list-extensions 2>/dev/null)
    if echo "$EXTENSIONS" | grep -q "universal-llm-provider"; then
        echo "✅ Universal LLM Extension is installed"
        echo "   Extension ID: your-name.universal-llm-provider"
    else
        echo "❌ Universal LLM Extension NOT found in installed extensions"
    fi
else
    echo "⚠️ VSCode CLI not in PATH"
    echo "   Try: export PATH=\"/Applications/Visual Studio Code.app/Contents/Resources/app/bin:\$PATH\""
fi

echo ""
echo "📋 Next Steps:"
echo "1. Open VS Code"
echo "2. Press Cmd+Shift+P to open Command Palette"
echo "3. Type 'Universal LLM: Configure Providers'"
echo "4. Configure your API keys"
echo "5. Open Chat (Cmd+I) and select a model"
echo ""
echo "📝 For detailed testing, see TEST_GUIDE.md"
