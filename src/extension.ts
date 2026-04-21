import * as vscode from 'vscode';
import fetch from 'node-fetch';

type DeepSeekModel = vscode.LanguageModelChatInformation;

export function activate(context: vscode.ExtensionContext) {
    const provider: vscode.LanguageModelChatProvider<DeepSeekModel> = {
        provideLanguageModelChatInformation(_options, _token) {
            return [
                {
                    id: 'deepseek-chat',
                    name: 'DeepSeek Chat',
                    family: 'deepseek',
                    version: '1.0',
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: {
                        toolCalling: false
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
                        toolCalling: false
                    }
                }
            ];
        },

        async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
            const config = vscode.workspace.getConfiguration('deepseek');
            const apiKey = config.get<string>('apiKey', '');
            const baseURL = config.get<string>('baseURL', 'https://api.deepseek.com');

            if (!apiKey) {
                throw new Error('DeepSeek API key not configured.');
            }

            const payloadMessages = messages.map((msg) => ({
                role: mapRole(msg.role),
                content: flattenParts(msg.content)
            }));

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
                throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
            }

            await new Promise<void>((resolve, reject) => {
                let buffer = '';

                response.body.on('data', (chunk: Buffer) => {
                    if (token.isCancellationRequested) {
                        resolve();
                        return;
                    }

                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) continue;

                        const data = trimmed.slice(5).trim();
                        if (data === '[DONE]') {
                            resolve();
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
                });

                response.body.on('end', () => resolve());
                response.body.on('error', reject);
            });
        },

        provideTokenCount(_model, text, _token) {
            const raw = typeof text === 'string' ? text : flattenParts(text.content);
            return Promise.resolve(Math.ceil(raw.length / 4));
        }
    };

    const registration = vscode.lm.registerLanguageModelChatProvider('deepseek', provider);

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
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' {
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
            return 'assistant';
    }
    // VS Code might not have a System role, treat everything else as user
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

export function deactivate() {}