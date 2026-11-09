import type { AppInput } from './api';

/**
 * Apps you can connect without Composio: each is an MCP server. Entries that need a key show a
 * short form; the rest connect in one click. Built-in capabilities are listed so the catalog
 * reads like Grok Bot's ("Built in").
 */

export interface CatalogField {
  key: string;
  label: string;
  placeholder?: string;
  /** Where the value goes: an HTTP header (as "Bearer <value>" for Authorization) or an env var for local servers. */
  target: { header: string; bearer?: boolean } | { env: string };
}

export interface CatalogApp {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  domain?: string;
  noAuth?: boolean;
  /** How to get the key, shown on the connect form. */
  help?: { text: string; url: string };
  fields?: CatalogField[];
  config?: Omit<AppInput, 'name' | 'description' | 'logo' | 'headers' | 'env'>;
}

export const logoFor = (domain?: string) => (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : undefined);

const bearer = (label: string, placeholder?: string): CatalogField[] => [{ key: 'token', label, placeholder, target: { header: 'Authorization', bearer: true } }];

export const CATALOG: CatalogApp[] = [
  {
    slug: 'zapier', name: 'Zapier', domain: 'zapier.com', categories: ['productivity', 'communication'],
    description: 'Gmail, Google Calendar, Slack, Sheets and 8,000+ more apps through your Zapier MCP server.',
    help: { text: 'Create an MCP server at mcp.zapier.com, add the apps and actions you want, then copy its token.', url: 'https://mcp.zapier.com' },
    fields: bearer('Zapier MCP token'), config: { transport: 'http', url: 'https://mcp.zapier.com/api/mcp/mcp' },
  },
  {
    slug: 'notion', name: 'Notion', domain: 'notion.so', categories: ['productivity'],
    description: 'Search, read and edit pages and databases you share with the integration.',
    help: { text: 'Create an internal integration, copy its secret, then share the pages it should see with it.', url: 'https://www.notion.so/profile/integrations' },
    fields: [{ key: 'token', label: 'Integration secret', placeholder: 'ntn_…', target: { env: 'NOTION_TOKEN' } }],
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
  },
  {
    slug: 'github', name: 'GitHub', domain: 'github.com', categories: ['developer tools'],
    description: 'Repos, issues, pull requests, code search and Actions.',
    help: { text: 'Create a fine-grained personal access token with the repos and permissions you want.', url: 'https://github.com/settings/personal-access-tokens' },
    fields: bearer('Personal access token', 'github_pat_…'), config: { transport: 'http', url: 'https://api.githubcopilot.com/mcp/' },
  },
  {
    slug: 'brave-search', name: 'Brave Search', domain: 'brave.com', categories: ['search'],
    description: 'Web, news, image, video and local search.',
    help: { text: 'Get a free API key from the Brave Search API dashboard.', url: 'https://api-dashboard.search.brave.com' },
    fields: [{ key: 'token', label: 'API key', target: { env: 'BRAVE_API_KEY' } }],
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'] },
  },
  {
    slug: 'context7', name: 'Context7', domain: 'context7.com', categories: ['developer tools'],
    description: 'Up-to-date docs and code examples for any library.',
    config: { transport: 'http', url: 'https://mcp.context7.com/mcp' },
  },
  {
    slug: 'exa', name: 'Exa', domain: 'exa.ai', categories: ['search'],
    description: 'AI web search, company research and code search.',
    config: { transport: 'http', url: 'https://mcp.exa.ai/mcp' },
  },
  {
    slug: 'stripe', name: 'Stripe', domain: 'stripe.com', categories: ['finance'],
    description: 'Customers, payments, invoices, products and refunds.',
    help: { text: 'Create a restricted API key with only the access your Bots need.', url: 'https://dashboard.stripe.com/apikeys' },
    fields: bearer('Restricted API key', 'rk_live_…'), config: { transport: 'http', url: 'https://mcp.stripe.com' },
  },
  {
    slug: 'deepwiki', name: 'DeepWiki', domain: 'deepwiki.com', categories: ['developer tools'],
    description: 'Ask questions about any public GitHub repository.',
    config: { transport: 'http', url: 'https://mcp.deepwiki.com/mcp' },
  },
  {
    slug: 'hugging-face', name: 'Hugging Face', domain: 'huggingface.co', categories: ['developer tools'],
    description: 'Search models, datasets, Spaces and papers.',
    config: { transport: 'http', url: 'https://huggingface.co/mcp' },
  },
  {
    slug: 'cloudflare-docs', name: 'Cloudflare Docs', domain: 'cloudflare.com', categories: ['developer tools'],
    description: 'Search Cloudflare’s developer documentation.',
    config: { transport: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' },
  },
  { slug: 'web-search', name: 'Web Search', categories: ['search'], noAuth: true, description: 'Every Bot can search and read the web.' },
  { slug: 'browser', name: 'Browser', categories: ['productivity'], noAuth: true, description: 'Every Bot has its own computer with a browser you can watch.' },
  { slug: 'terminal', name: 'Terminal', categories: ['developer tools'], noAuth: true, description: 'Every Bot can run commands and code on your VM.' },
];

/** Build the server request for a catalog app plus the values typed into its form. */
export function catalogInput(app: CatalogApp, values: Record<string, string>): AppInput {
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const f of app.fields ?? []) {
    const v = (values[f.key] ?? '').trim();
    if ('header' in f.target) headers[f.target.header] = f.target.bearer ? `Bearer ${v}` : v;
    else env[f.target.env] = v;
  }
  return { name: app.name, description: app.description, logo: logoFor(app.domain), ...app.config, headers, env };
}
