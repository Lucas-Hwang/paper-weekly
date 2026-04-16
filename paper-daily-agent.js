#!/usr/bin/env node
/**
 * PaperDaily Agent — 封装版（自驱动）
 * 用法：node paper-daily-agent.js [ai|yanyu|all]
 *
 * 读取同目录下的 agent-config.json 获取所有配置
 * 无需修改本脚本，只需修改配置文件即可定制行为
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// ========== 配置加载 ==========
const SCRIPT_DIR = path.dirname(fs.realpathSync(__filename));
const CONFIG_PATH = path.join(SCRIPT_DIR, 'agent-config.json');
const LOG_DIR = path.join(SCRIPT_DIR, 'logs');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { smtp, accounts, baiduTranslate } = config;

// 允许通过环境变量覆盖敏感配置（方便 CI/GitHub Actions）
if (process.env.SMTP_PASS) smtp.auth.pass = process.env.SMTP_PASS;
if (baiduTranslate) {
  if (process.env.BAIDU_APPID) baiduTranslate.appid = process.env.BAIDU_APPID;
  if (process.env.BAIDU_KEY) baiduTranslate.key = process.env.BAIDU_KEY;
}

// ========== 邮件发送 ==========
function createTransporter() {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.auth.user,
      pass: smtp.auth.pass
    }
  });
}

async function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const transporter = createTransporter();
    transporter.sendMail({
      from: `"arXiv论文日报" <${smtp.from}>`,
      to,
      subject,
      html
    }, (err, info) => {
      if (err) reject(err);
      else resolve(info);
    });
  });
}

// ========== 百度翻译 ==========
async function translateBaidu(text, retries = 1) {
  if (!baiduTranslate || !baiduTranslate.appid || !baiduTranslate.key) {
    return text;
  }
  // 百度标准版单次最长 6000 字符
  const safeText = text.length > 5800 ? text.substring(0, 5800) + '…' : text;
  const { appid, key } = baiduTranslate;
  const salt = Date.now().toString();
  const sign = crypto.createHash('md5').update(appid + safeText + salt + key).digest('hex');
  const params = new URLSearchParams({
    q: safeText,
    from: 'en',
    to: 'zh',
    appid,
    salt,
    sign
  });
  const url = `https://fanyi-api.baidu.com/api/trans/vip/translate?${params.toString()}`;
  try {
    const data = await fetchUrl(url);
    const json = JSON.parse(data);
    if (json.error_code) {
      if ((json.error_code === '54003' || json.error_code === '54005') && retries > 0) {
        await new Promise(r => setTimeout(r, 1500));
        return translateBaidu(safeText, retries - 1);
      }
      throw new Error(`Baidu API ${json.error_code}: ${json.error_msg}`);
    }
    return json.trans_result.map(r => r.dst).join('\n');
  } catch (err) {
    console.warn(`  ⚠️ 百度翻译失败: ${err.message}`);
    return text;
  }
}

// ========== PubMed API ==========
function extractAuthorsFromPubMed(articleXml) {
  const authorListMatch = articleXml.match(/<AuthorList[^>]*>([\s\S]*?)<\/AuthorList>/i);
  if (!authorListMatch) return { names: [], firstAffiliation: '' };
  const authors = [];
  let firstAffiliation = '';
  const authorBlocks = authorListMatch[1].split(/<\/Author>/i);
  for (const block of authorBlocks) {
    const lastName = extractField(block, 'LastName');
    const foreName = extractField(block, 'ForeName');
    if (lastName) {
      const fullName = foreName ? `${foreName} ${lastName}` : lastName;
      authors.push(fullName);
      if (!firstAffiliation) {
        const aff = extractField(block, 'Affiliation');
        if (aff) firstAffiliation = aff;
      }
    }
  }
  return { names: authors, firstAffiliation };
}

function extractDoiFromPubMed(articleXml) {
  const m = articleXml.match(/<ArticleId\s+IdType=["']doi["']\s*>([^<]*)<\/ArticleId>/i);
  return m ? m[1] : '';
}

function extractAbstractFromPubMed(articleXml) {
  const abstractMatch = articleXml.match(/<Abstract[^>]*>([\s\S]*?)<\/Abstract>/i);
  if (!abstractMatch) return '';
  const texts = [];
  const regex = /<AbstractText(?:\s+Label=["'][^"']*["'])?\s*>([\s\S]*?)<\/AbstractText>/gi;
  let match;
  while ((match = regex.exec(abstractMatch[1])) !== null) {
    texts.push(match[1].replace(/<[^>]+>/g, '').trim());
  }
  return texts.join(' ');
}

function extractPubDateFromPubMed(articleXml) {
  const pubDateMatch = articleXml.match(/<PubDate>([\s\S]*?)<\/PubDate>/i);
  if (pubDateMatch) {
    const year = extractField(pubDateMatch[1], 'Year');
    const month = extractField(pubDateMatch[1], 'Month');
    const day = extractField(pubDateMatch[1], 'Day');
    if (year) return [year, month, day].filter(Boolean).join('-');
  }
  const revisedMatch = articleXml.match(/<DateRevised>([\s\S]*?)<\/DateRevised>/i);
  if (revisedMatch) {
    const year = extractField(revisedMatch[1], 'Year');
    const month = extractField(revisedMatch[1], 'Month');
    const day = extractField(revisedMatch[1], 'Day');
    if (year) return [year, month, day].filter(Boolean).join('-');
  }
  return '';
}

async function searchPubMed(term, maxResults = 20) {
  const encodedTerm = encodeURIComponent(term);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodedTerm}&retmode=json&retmax=${maxResults}&sort=date`;
  try {
    const data = await fetchUrl(url);
    const json = JSON.parse(data);
    return json.esearchresult.idlist || [];
  } catch (err) {
    console.warn(`  ⚠️ PubMed esearch 失败: ${err.message}`);
    return [];
  }
}

async function fetchPubMedDetails(pmids) {
  if (!pmids || pmids.length === 0) return [];
  const ids = pmids.join(',');
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids}&retmode=xml`;
  try {
    const xml = await fetchUrl(url);
    const articles = xml.split('<PubmedArticle>').slice(1);
    return articles.map(articleXml => {
      const title = stripHtml(extractField(articleXml, 'ArticleTitle')).replace(/\s+/g, ' ');
      const summary = extractAbstractFromPubMed(articleXml);
      const published = extractPubDateFromPubMed(articleXml);
      const doi = extractDoiFromPubMed(articleXml);
      const { names, firstAffiliation } = extractAuthorsFromPubMed(articleXml);
      const pmid = extractField(articleXml, 'PMID');
      return {
        title,
        summary,
        published,
        doi,
        authors: names.slice(0, 3).join(', '),
        firstAffiliation,
        url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '',
        source: 'PubMed'
      };
    }).filter(p => p.title && p.summary.length > 30);
  } catch (err) {
    console.warn(`  ⚠️ PubMed efetch 失败: ${err.message}`);
    return [];
  }
}

// ========== 论文采集 ==========
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'PaperDaily-Agent/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractField(xml, field) {
  const m = xml.match(new RegExp(`<${field}[^>]*>([\\s\\S]*?)<\\/${field}>`, 'i'));
  return m ? stripHtml(m[1]).substring(0, 300) : '';
}

function stripHtml(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&hellip;/g, '…')
    .trim();
}

async function fetchArXiv(keywords, maxResults = 20) {
  const query = keywords.map(k => `all:${k}`).join('+AND+');
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  try {
    const xml = await fetchUrl(url);
    const entries = xml.split('<entry>').slice(1);
    return entries.map(e => ({
      title: stripHtml(extractField(e, 'title')).replace(/\s+/g, ' '),
      authors: stripHtml(extractField(e, 'author')).replace(/\s+/g, ' '),
      published: extractField(e, 'published'),
      summary: stripHtml(extractField(e, 'summary')),
      url: extractField(e, 'id'),
      arxivId: extractField(e, 'id').split('/').pop()
    })).filter(p => p.title && p.summary.length > 30);
  } catch (err) {
    console.warn(`  ⚠️ arXiv API 失败: ${err.message}`);
    return [];
  }
}

async function fetchRSS(keywords) {
  const feeds = {
    csAI: 'http://export.arxiv.org/rss/cs.AI',
    csLG: 'http://export.arxiv.org/rss/cs.LG',
    csCV: 'http://export.arxiv.org/rss/cs.CV',
    eessSY: 'http://export.arxiv.org/rss/eess.SY',
    qBio: 'http://export.arxiv.org/rss/q-bio.QM',
  };
  const all = [];
  for (const [name, url] of Object.entries(feeds)) {
    try {
      const xml = await fetchUrl(url);
      const items = xml.split('<item>').slice(1);
      for (const item of items) {
        const rawTitle = stripHtml(extractField(item, 'title')).replace(/\s+/g, ' ');
        const rawDesc = stripHtml(extractField(item, 'description')).replace(/\s+/g, ' ');
        const combined = (rawTitle + ' ' + rawDesc).toLowerCase();
        if (keywords.some(k => combined.includes(k.toLowerCase()))) {
          all.push({
            title: rawTitle,
            authors: stripHtml(extractField(item, 'author')).replace(/\s+/g, ' '),
            published: extractField(item, 'pubDate'),
            summary: rawDesc.substring(0, 300),
            url: extractField(item, 'link'),
            source: 'arXiv RSS'
          });
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return all;
}

function scorePaper(paper, topic) {
  const text = (paper.title + ' ' + paper.summary).toLowerCase();
  let score = 0;
  for (const kw of topic.keywords) {
    const count = (text.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
    score += count * topic.weight;
  }
  if (topic.authorKeywords) {
    for (const akw of topic.authorKeywords) {
      if (paper.title.includes(akw) || paper.authors.includes(akw)) score += 25;
    }
  }
  return score;
}

async function fetchPapersForAccount(account) {
  const { id, name, topicName, recipient, topics, paperLimit, perTopicLimit, prompt, source } = account;
  const allPapers = [];
  const today = new Date().toISOString().split('T')[0];

  console.log(`\n📡 [${id}] ${name} — 采集开始`);

  for (const topic of topics) {
    const kwList = topic.keywords.slice(0, 3);
    console.log(`  🔍 [${topic.name}] 关键词: ${kwList.join(', ')}`);

    let pool = [];
    if (source === 'pubmed') {
      const term = kwList.join(' AND ');
      const pmids = await searchPubMed(term, 20);
      if (pmids.length > 0) {
        pool = await fetchPubMedDetails(pmids);
      }
    } else {
      const [rssPapers, apiPapers] = await Promise.all([
        fetchRSS(topic.keywords),
        fetchArXiv(kwList, 20)
      ]);
      pool = [...rssPapers, ...apiPapers];
    }

    const filtered = pool.filter(p => {
      const text = (p.title + ' ' + p.summary).toLowerCase();
      return topic.keywords.some(k => text.includes(k.toLowerCase()));
    });

    const scored = filtered.map(p => ({
      ...p,
      score: scorePaper(p, topic),
      topicName: topic.name
    }));
    scored.sort((a, b) => b.score - a.score);

    const limit = perTopicLimit[topic.name] || 2;
    allPapers.push(...scored.slice(0, limit));
    console.log(`    → 命中 ${scored.length} 篇，取 ${Math.min(scored.length, limit)} 篇`);

    await new Promise(r => setTimeout(r, 2000));
  }

  // 去重
  const seen = new Set();
  const unique = allPapers.filter(p => {
    const key = p.title.substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result = unique.slice(0, paperLimit);

  // 保存日志
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LOG_DIR, `fetch_${today}_${id}.json`),
    JSON.stringify({ account: id, fetchedAt: new Date().toISOString(), totalCount: result.length, papers: result }, null, 2)
  );

  // 翻译标题和摘要
  console.log(`  🌐 开始翻译 ${result.length} 篇论文...`);
  for (const p of result) {
    p.titleZh = await translateBaidu(p.title);
    await new Promise(r => setTimeout(r, 1100));
    p.summaryZh = await translateBaidu(p.summary);
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`  ✅ 共采集 ${result.length} 篇（已翻译）\n`);
  return { account, topicName, recipient, name, papers: result, prompt };
}

// ========== HTML 生成 ==========
function buildHTML(accountData) {
  const { name, topicName, papers, recipient } = accountData;
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日 ${['周日','周一','周二','周三','周四','周五','周六'][today.getDay()]}`;

  const topicBadge = name.includes('医工') || name.includes('医') ? '#dcfce7' : '#dbeafe';
  const topicColor = name.includes('医工') || name.includes('医') ? '#166534' : '#1d4ed8';

  const paperRows = papers.map((p, i) => {
    const isPubMed = p.source === 'PubMed';
    if (isPubMed) {
      return `
  <div class="paper">
    <div class="paper-title">
      ${i+1}. ${escapeHtml(p.titleZh || p.title)}
    </div>
    <div class="paper-original-title">
      ${escapeHtml(p.title)}
    </div>
    <div class="paper-meta">
      <span class="authors">${escapeHtml(p.authors)}</span> ·
      <span class="date">${p.published ? p.published.substring(0, 10) : ''}</span> ·
      <span class="score">相关度 ${p.score}</span>
    </div>
    ${p.firstAffiliation ? `<div class="paper-affiliation">单位：${escapeHtml(p.firstAffiliation)}</div>` : ''}
    ${p.doi ? `<div class="paper-doi">DOI: <a href="https://doi.org/${escapeHtml(p.doi)}" target="_blank">${escapeHtml(p.doi)}</a></div>` : ''}
    <div class="paper-summary">${escapeHtml(p.summaryZh || p.summary)}</div>
    <div class="paper-topic-tag" style="background:${topicBadge};color:${topicColor}">${escapeHtml(p.topicName)}</div>
  </div>`;
    }
    return `
  <div class="paper">
    <div class="paper-title">
      ${i+1}. ${escapeHtml(p.titleZh || p.title)}
    </div>
    <div class="paper-meta">
      <span class="authors">${escapeHtml(p.authors)}</span> ·
      <span class="date">${p.published ? p.published.substring(0, 10) : ''}</span> ·
      <span class="score">相关度 ${p.score}</span>
    </div>
    <div class="paper-summary">${escapeHtml((p.summaryZh || p.summary).substring(0, 350))}${(p.summaryZh || p.summary).length > 350 ? '…' : ''}</div>
    <div class="paper-topic-tag" style="background:${topicBadge};color:${topicColor}">${escapeHtml(p.topicName)}</div>
  </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(name)} | ${dateStr}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f8f9fa}
  h1{color:#1a1a2e;font-size:22px;margin-bottom:4px}
  .date{color:#888;font-size:13px;margin-bottom:20px}
  .section{background:#fff;border-radius:12px;padding:20px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
  .paper{margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid #f0f0f0}
  .paper:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
  .paper-title{font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:4px;line-height:1.4}
  .paper-original-title{font-size:12px;color:#555;font-style:italic;margin-bottom:6px;line-height:1.4}
  .paper-meta{font-size:12px;color:#888;margin-bottom:6px}
  .paper-affiliation{font-size:12px;color:#444;margin-bottom:4px}
  .paper-doi{font-size:12px;color:#1d4ed8;margin-bottom:6px}
  .paper-doi a{color:#1d4ed8;text-decoration:none}
  .authors{font-weight:500;color:#555}
  .score{color:#f59e0b;font-weight:700}
  .paper-summary{font-size:13px;color:#555;line-height:1.6;margin-bottom:6px}
  .paper-topic-tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .footer{text-align:center;color:#aaa;font-size:11px;margin-top:30px}
</style>
</head>
<body>
<h1>📄 ${escapeHtml(name)}</h1>
<div class="date">${dateStr} · 共 ${papers.length} 篇</div>
<div class="section">
${paperRows}
</div>
<div class="footer">由 PaperDaily Agent 自动生成 · ${new Date().toLocaleString('zh-CN')}</div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ========== 主流程 ==========
async function main() {
  const args = process.argv.slice(2);
  const target = args[0] || 'all';
  const today = new Date().toISOString().split('T')[0];
  const startTime = Date.now();

  console.log(`\n========== 🤖 PaperDaily Agent 启动 | ${new Date().toLocaleString('zh-CN')} ==========\n`);

  let targets = [];
  if (target === 'all') {
    targets = accounts;
  } else {
    const found = accounts.find(a => a.id === target);
    targets = found ? [found] : [];
    if (!targets.length) {
      console.error(`❌ 未找到账号: ${target}，可用: ${accounts.map(a=>a.id).join(', ')}, all`);
      process.exit(1);
    }
  }

  const results = [];
  for (const account of targets) {
    try {
      const data = await fetchPapersForAccount(account);
      const html = buildHTML(data);
      await sendEmail(
        account.recipient,
        `📄 ${account.name} | ${today} | ${data.papers.length}篇`,
        html
      );
      console.log(`  📧 已发送到 ${account.recipient}`);
      results.push({ account: account.id, status: 'ok', count: data.papers.length });
    } catch (err) {
      console.error(`  ❌ ${account.name} 失败: ${err.message}`);
      results.push({ account: account.id, status: 'error', error: err.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n========== ✅ 完成 | 耗时 ${elapsed}s ==========\n`);
  results.forEach(r => {
    const icon = r.status === 'ok' ? '✅' : '❌';
    console.log(`  ${icon} ${r.account}: ${r.status === 'ok' ? `${r.count}篇已发送` : r.error}`);
  });

  // 汇总日志
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const summaryLog = path.join(LOG_DIR, `daily_${today}.log`);
  fs.appendFileSync(summaryLog, `[${new Date().toISOString()}] 完成: ${JSON.stringify(results)}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
