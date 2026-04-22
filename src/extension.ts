import * as vscode from 'vscode';

type DeepSeekModel = vscode.LanguageModelChatInformation;

export function activate(context: vscode.ExtensionContext) {
    console.log('[DeepSeek] Starting activation...');
    
    try {
        // Use the vendor ID declared in package.json
        const vendor = 'deepseek';
        console.log(`[DeepSeek] Registering with vendor: ${vendor}`);
        
        const provider: vscode.LanguageModelChatProvider<DeepSeekModel> = {
            provideLanguageModelChatInformation(_options, _token) {
                console.log(`[DeepSeek] ${vendor}: Providing model information`);
                return [
                    {
                        id: 'deepseek-chat',
                        name: 'DeepSeek Chat',
                        family: 'deepseek',
                        version: '1.0',
                        maxInputTokens: 128000,
                        maxOutputTokens: 4096,
                        capabilities: {
                            toolCalling: true
                        }
                    },
                    {
                        id: 'deepseek-coder',
                        name: 'DeepSeek Coder',
                        family: 'deepseek',
                        version: '1.0',
                        maxInputTokens: 128000,
                        maxOutputTokens: 4096,
                        capabilities: {
                            toolCalling: true
                        }
                    }
                ];
            },

            async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
                console.log(`[DeepSeek] ${vendor}: API request for model ${model.id}`);
                const config = vscode.workspace.getConfiguration('deepseek');
                const apiKey = config.get<string>('apiKey', '');
                const baseURL = config.get<string>('baseURL', 'https://api.deepseek.com');

                if (!apiKey) {
                    throw new Error('DeepSeek API key not configured. Run "Configure DeepSeek API Key" command.');
                }

                const payloadMessages = messages.map((msg) => ({
                    role: mapRole(msg.role),
                    content: flattenParts(msg.content)
                }));

                console.log(`[DeepSeek] ${vendor}: Calling API: ${baseURL}/chat/completions`);
                const response = await fetch(`${baseURL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: model.id,
                        messages: payloadMessages,
                        stream: true
                    })
                });

                if (!response.ok || !response.body) {
                    const errorText = await response.text().catch(() => '');
                    throw new Error(`DeepSeek API error ${response.status}: ${response.statusText}. ${errorText}`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';

                try {
                    while (true) {
                        if (token.isCancellationRequested) {
                            console.log(`[DeepSeek] ${vendor}: Request cancelled`);
                            break;
                        }

                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed.startsWith('data:')) continue;

                            const data = trimmed.slice(5).trim();
                            if (data === '[DONE]') {
                                console.log(`[DeepSeek] ${vendor}: Stream complete`);
                                return;
                            }

                            try {
                                const parsed = JSON.parse(data);
                                const text = parsed?.choices?.[0]?.delta?.content;
                                if (text) {
                                    progress.report(new vscode.LanguageModelTextPart(text));
                                }
                            } catch {
                                // ignore partial/incomplete chunks
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            },

            provideTokenCount(_model, text, _token) {
                const raw = typeof text === 'string' ? text : flattenParts(text.content);
                return Promise.resolve(Math.ceil(raw.length / 4));
            }
        };

        const registration = vscode.lm.registerLanguageModelChatProvider(vendor, provider);
        console.log(`[DeepSeek] ✅ Successfully registered with vendor: ${vendor}`);
        
        const configureCommand = vscode.commands.registerCommand('deepseek.configure', async () => {
            const config = vscode.workspace.getConfiguration('deepseek');
            const currentKey = config.get<string>('apiKey', '');
            const newKey = await vscode.window.showInputBox({
                prompt: 'Enter your DeepSeek API key',
                password: true,
                value: currentKey,
                ignoreFocusOut: true
            });

            if (newKey !== undefined) {
                await config.update('apiKey', newKey, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('DeepSeek API key saved.');
            }
        });

        context.subscriptions.push(registration, configureCommand);
        console.log(`[DeepSeek] 🎉 Extension activation COMPLETE with vendor: ${vendor}`);
        
    } catch (error) {
        console.error('[DeepSeek] 💥 FATAL ACTIVATION ERROR:', error);
        console.error('[DeepSeek] Stack trace:', error instanceof Error ? error.stack : 'No stack');
        vscode.window.showErrorMessage(`DeepSeek failed to activate: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
        return 'assistant';
    }
    return 'user';
}

function flattenParts(parts: readonly unknown[]): string {
    return parts.map(part => {
        if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
        }
        return typeof part === 'string' ? part : '';
    }).join('');
}

export function deactivate() {
    console.log('[DeepSeek] Extension deactivating...');
}
