import {readFileSync,writeFileSync} from 'node:fs';
import {Store} from '../dist/store.js';
import {createRegistry} from '../dist/registry.js';
const store=new Store(':memory:',Buffer.alloc(32));
const config={product:'facebook_login',apiVersion:'v26.0',appId:'0',appSecret:'documentation-only',encryptionKey:Buffer.alloc(32),databasePath:':memory:',redirectUri:'http://localhost:8787/oauth/callback',httpHost:'127.0.0.1',httpPort:8788};
const {tools}=createRegistry(config,store);
const table=tools.map(t=>`| \`${t.name}\` | ${t.endpoints.map(e=>`\`${e.method} ${e.path.replaceAll('|',' or ')}\``).join('<br>')} | ${t.requiredPermissions.map(p=>`\`${p}\``).join('<br>')}${t.requiredFeatures?`<br>Feature: ${t.requiredFeatures.join(', ')}`:''}${t.conditionalPermissions?'<br>Additional field-specific permissions below':''} | ${t.write?'Write'+(t.destructive?' · destructive':''):'Read'} | ${t.endpoints.every(e=>e.method==='LOCAL')?'Local workflow':'Implemented · Facebook Login'} |`).join('\n');
const details=tools.map(t=>`### ${t.name}\n\n${t.description}\n\n- Input fields: ${Object.keys(t.inputSchema.shape).map(k=>`\`${k}\``).join(', ')||'none'}.\n- Validation: ${t.validation}\n- Errors: ${t.errorMapping.map(e=>`\`${e}\``).join(', ')}.\n- [Official documentation](${t.documentation}).${t.conditionalPermissions?'\n- Field-specific grants: '+Object.entries(t.conditionalPermissions).map(([f,p])=>`\`${f}\` → ${p.map(s=>`\`${s}\``).join(', ')}`).join('; ')+'.':''}`).join('\n\n');
const text=`# MCP tool reference\n\nGenerated from the executable registry. **${tools.length} tools**, pinned to Graph API **v26.0**. Run \`npm run build && npm run docs:generate\` after changing tool definitions.\n\nAll IDs in account paths come from the OAuth connection. No tool accepts a raw access token or arbitrary HTTP URL/route. See [API research and legacy compatibility](INSTAGRAM_API.md).\n\n| MCP Tool | Instagram API | Permission | Read/Write | Current Status |\n| --- | --- | --- | --- | --- |\n${table}\n\nOwnership preflights additionally read \`GET /MEDIA_ID?fields=id,owner,media_type,media_product_type\` and, for comments, \`GET /COMMENT_ID?fields=id,media\`. They require the same base read permissions. A read tool never silently mutates Instagram. Write tools first produce a local pending approval; only a separately approved exact action can reach its documented write endpoint.\n\n${details}\n`;
const path=new URL('../docs/TOOLS.md',import.meta.url);
if(process.argv.includes('--check')) {
  if(readFileSync(path,'utf8')!==text) throw new Error('docs/TOOLS.md is stale; run docs:generate.');
  process.stdout.write(`Tool documentation matches all ${tools.length} registered tools.\n`);
} else {writeFileSync(path,text);process.stdout.write(`Generated documentation for ${tools.length} tools.\n`);}
store.close();
