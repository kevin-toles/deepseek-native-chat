# Universal LLM Extension - Test Guide

## ✅ Extension Installation Status
- **Extension ID**: `your-name.universal-llm-provider`
- **Version**: 0.1.0
- **Status**: ✅ Successfully installed

## 🧪 Manual Test Steps

### Step 1: Open VS Code
```bash
# Open VS Code (it should already be open)
```

### Step 2: Configure Providers
1. Open Command Palette: `Cmd+Shift+P`
2. Type: `Universal LLM: Configure Providers`
3. Press Enter
4. Select "DeepSeek" from the list
5. Enter your DeepSeek API key
6. Press Enter

**Expected Result**: "DeepSeek API key saved" message appears

### Step 3: Verify Configuration
1. Open Command Palette: `Cmd+Shift+P`
2. Type: `Universal LLM: Show Status`
3. Press Enter

**Expected Result**: Status message shows "DeepSeek: Enabled (2 models)"

### Step 4: Test Chat Interface
1. Open Chat: `Cmd+I`
2. Click the model selector dropdown (top of chat panel)
3. Look for "Universal LLM" section
4. Select "DeepSeek Chat"
5. Type a test message: "Hello, can you help me?"
6. Press Enter

**Expected Result**: 
- Streaming response from DeepSeek API
- Text appears in real-time
- No errors in output

### Step 5: Test Another Model
1. In chat, click model selector again
2. Select "DeepSeek Coder"
3. Ask a coding question: "Write a Python function to reverse a string"
4. Press Enter

**Expected Result**: Code response from DeepSeek Coder model

## 🔧 Troubleshooting

### If models don't appear:
1. Check extension is enabled in Extensions view
2. Restart VS Code
3. Check Developer Tools console for errors: `Help → Toggle Developer Tools`

### If API calls fail:
1. Verify API key is correct
2. Check network connectivity
3. Look for error messages in chat or console

### If extension doesn't activate:
1. Check Output panel: `View → Output`
2. Select "Universal LLM" from dropdown
3. Look for activation logs

## 📊 Expected Output

When working correctly, you should see:
- ✅ Models appear in chat dropdown under "Universal LLM"
- ✅ Streaming responses in real-time
- ✅ No TypeScript/compilation errors
- ✅ Configuration persists between sessions

## 🎯 Success Criteria

The extension is working if:
1. ✅ Models appear in chat dropdown
2. ✅ Can select and switch between models
3. ✅ Receives streaming responses
4. ✅ No crashes or errors
5. ✅ Configuration UI works

## 🚀 Next Steps After Testing

If tests pass:
1. Add more providers (Qwen, Zhipu, Moonshot)
2. Test with real API keys
3. Add tool calling support
4. Implement model discovery
5. Create webview configuration UI

## 📝 Test Log

Record your test results here:
- [ ] Step 1: Configuration UI works
- [ ] Step 2: Models appear in dropdown
- [ ] Step 3: DeepSeek Chat responds
- [ ] Step 4: DeepSeek Coder responds
- [ ] Step 5: No errors in console
- [ ] Step 6: Configuration persists

**Test Date**: $(date)
**Tester**: 
**Results**: 
**Issues Found**: 
**Notes**: 
