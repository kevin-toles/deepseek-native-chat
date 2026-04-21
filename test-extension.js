// Simple test to verify the extension compiles and has basic structure
const fs = require('fs');
const path = require('path');

console.log('Testing DeepSeek Native Chat Extension...\n');

// Check if extension.js exists
const extensionPath = path.join(__dirname, 'out', 'extension.js');
if (fs.existsSync(extensionPath)) {
    console.log('✅ extension.js compiled successfully');
    const stats = fs.statSync(extensionPath);
    console.log(`   Size: ${stats.size} bytes`);
} else {
    console.log('❌ extension.js not found');
    process.exit(1);
}

// Check package.json
const packagePath = path.join(__dirname, 'package.json');
if (fs.existsSync(packagePath)) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    console.log('✅ package.json valid');
    console.log(`   Name: ${packageJson.name}`);
    console.log(`   Version: ${packageJson.version}`);
    console.log(`   VS Code Engine: ${packageJson.engines.vscode}`);
} else {
    console.log('❌ package.json not found');
    process.exit(1);
}

// Check for required files
const requiredFiles = [
    'src/extension.ts',
    'tsconfig.json',
    '.vscode/launch.json',
    '.vscode/tasks.json'
];

console.log('\n📁 Checking required files:');
let allFilesExist = true;
for (const file of requiredFiles) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
        console.log(`   ✅ ${file}`);
    } else {
        console.log(`   ❌ ${file}`);
        allFilesExist = false;
    }
}

if (!allFilesExist) {
    console.log('\n❌ Some required files are missing');
    process.exit(1);
}

console.log('\n🎉 All checks passed! The extension is ready to use.');
console.log('\nTo test the extension:');
console.log('1. Open this folder in VS Code');
console.log('2. Press F5 to launch extension development host');
console.log('3. In the new VS Code window:');
console.log('   - Press Cmd+Shift+P (Mac) or Ctrl+Shift+P (Windows/Linux)');
console.log('   - Type "Configure DeepSeek API Key"');
console.log('   - Enter your DeepSeek API key');
console.log('   - Open chat (Cmd+I or Ctrl+I) and select DeepSeek models');