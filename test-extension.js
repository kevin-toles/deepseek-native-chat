const vscode = require('vscode');

// Test the extension activation
async function testExtension() {
  console.log('Testing Universal LLM Extension...');
  
  try {
    // Check if extension is loaded
    const extension = vscode.extensions.getExtension('your-name.universal-llm-provider');
    if (!extension) {
      console.error('❌ Extension not found');
      return;
    }
    
    console.log('✅ Extension found:', extension.id);
    
    // Check if extension is active
    if (!extension.isActive) {
      console.log('⚠️ Extension not active, activating...');
      await extension.activate();
    }
    
    console.log('✅ Extension is active');
    
    // Test configuration
    const config = vscode.workspace.getConfiguration('universal-llm');
    const providers = config.get('providers');
    console.log('📋 Configured providers:', providers ? providers.length : 0);
    
    // Show test instructions
    console.log('\n🎯 TEST INSTRUCTIONS:');
    console.log('1. Open VS Code');
    console.log('2. Open Command Palette (Cmd+Shift+P)');
    console.log('3. Run "Universal LLM: Configure Providers"');
    console.log('4. Select DeepSeek and enter your API key');
    console.log('5. Open Chat (Cmd+I)');
    console.log('6. Click model selector → Select "DeepSeek Chat"');
    console.log('7. Start chatting!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testExtension();
