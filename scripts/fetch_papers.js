#!/usr/bin/env node
/**
 * PaperDaily 采集器 v3 - 多账号版
 * 支持：AI前沿日报(2382710205) + 医工交叉日报(1370091992)
 * 2026-04-09
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== 配置加载 ==========
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const ACCOUNT = process.argv[2] || 'yanyu'; // 默认医工交叉账号
const accountConfig = config.accounts.find(a => a.id === ACCOUNT) || config.accounts[0];

// ========== 工具函数 ==========
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'PaperDaily/3.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractField(xml, field) {
  const m = xml.match(new RegExp(`<${field}[^>]*>([\\s\\S]*?)<\\/${field}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, '').trim().substring(0, 300) : '';
}

// ========== arXiv 采集 ==========
async function fetchArXiv(feed, keywords, maxResults = 20) {
  const query = keywords.map(k => `all:${k}`).join('+AND+');
  const url = `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  
  try {
    const xml = await fetchUrl(url);
    const entries = xml.split('<entry>').slice(1);
    return entries.map(e => ({
      title: extractField(e, 'title').replace(/\s+/g, ' '),
      authors: extractField(e, 'author').replace(/\s+/g, ' '),
      published: extractField(e, 'published'),
      summary: extractField(e, 'summary'),
      url: extractField(e, 'id'),
      arxivId: extractField(e, 'id').split('/').pop()
    })).filter(p => p.title && p.summary.length > 50);
  } catch (err) {
    console.warn(`  ⚠️ arXiv ${feed} 失败: ${err.message}`);
    return [];
  }
}

// ========== RSS 采集（备用） ==========
async function fetchRSS(topicName, keywords) {
  const feeds = {
    csAI: 'http://export.arxiv.org/rss/cs.AI',
    csLG: 'http://export.arxiv.org/rss/cs.LG',
    csCL: 'http://export.arxiv.org/rss/cs.CL',
    csCV: 'http://export.arxiv.org/rss/cs.CV',
    eessSY: 'http://export.arxiv.org/rss/eess.SY',
  };

  const allPapers = [];
  for (const [feed, rssUrl] of Object.entries(feeds)) {
    try {
      const xml = await fetchUrl(rssUrl);
      const items = xml.split('<item>').slice(1);
      for (const item of items) {
        const title = extractField(item, 'title').replace(/\s+/g, ' ');
        const desc = extractField(item, 'description').replace(/\s+/g, ' ');
        const combined = (title + ' ' + desc).toLowerCase();
        if (keywords.some(k => combined.includes(k.toLowerCase()))) {
          allPapers.push({
            title,
            authors: extractField(item, 'author'),
            published: extractField(item, 'pubDate'),
            summary: desc,
            url: extractField(item, 'link'),
            source: 'arXiv RSS',
            feed
          });
        }
      }
    } catch (e) {
      // 静默跳过
    }
    await new Promise(r => setTimeout(r, 1500)); // RSS 限速
  }
  return allPapers.slice(0, 10);
}

// ========== 关键词匹配打分 ==========
function scorePaper(paper, topic) {
  const text = (paper.title + ' ' + paper.summary).toLowerCase();
  let score = 0;
  for (const kw of topic.keywords) {
    const count = (text.match(new RegExp(kw.toLowerCase(), 'g')) || []).length;
    score += count * topic.weight;
  }
  // 作者关键词额外加分
  if (topic.authorKeywords) {
    for (const akw of topic.authorKeywords) {
      if (paper.title.includes(akw) || paper.authors.includes(akw)) score += 20;
    }
  }
  return score;
}

// ========== 主采集逻辑 ==========
async function main() {
  const topicsConfig = accountConfig.topics;
  const topicList = topicsConfig.priority;
  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(__dirname, '..', 'logs', `fetch_${today}_${ACCOUNT}.json`);
  const allPapers = [];

  console.log(`\n📡 PaperDaily 采集器 v3 | ${new Date().toLocaleString('zh-CN')}`);
  console.log(`👤 账号: ${accountConfig.id} | ${accountConfig.description}\n`);

  for (const topic of topicList) {
    console.log(`  🔍 [${topic.name}] 关键词: ${topic.keywords.slice(0, 3).join(', ')}...`);
    
    // 尝试 RSS（稳定）
    let papers = await fetchRSS(topic.name, topic.keywords);
    
    // 同时尝试 API（更高覆盖率）
    const kwList = topic.keywords.slice(0, 3);
    try {
      const apiPapers = await fetchArXiv(topic.name, kwList, 15);
      papers = [...papers, ...apiPapers];
    } catch (e) {}
    
    // 关键词过滤
    const filtered = papers.filter(p => {
      const text = (p.title + ' ' + p.summary).toLowerCase();
      return topic.keywords.some(k => text.includes(k.toLowerCase()));
    });
    
    // 按相关度打分
    const scored = filtered.map(p => ({ ...p, score: scorePaper(p, topic), topic: topic.name }));
    scored.sort((a, b) => b.score - a.score);
    
    const limit = topicsConfig.paperLimitPerTopic?.[topic.name] || 2;
    allPapers.push(...scored.slice(0, limit));
    
    console.log(`    → 命中 ${scored.length} 篇，取 ${Math.min(scored.length, limit)} 篇`);
    
    await new Promise(r => setTimeout(r, 2000)); // 全局限速
  }

  // 去重 + 截取
  const seen = new Set();
  const unique = allPapers.filter(p => {
    const key = p.title.substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result = unique.slice(0, topicsConfig.dailyLimit);
  console.log(`\n✅ 共采集 ${result.length} 篇论文\n`);

  result.forEach((p, i) => {
    console.log(`  ${i + 1}. [${p.topic}] ${p.title}`);
    console.log(`     → ${p.url || p.link}\n`);
  });

  // 保存
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify({
    account: ACCOUNT,
    fetchedAt: new Date().toISOString(),
    totalCount: result.length,
    papers: result
  }, null, 2));

  console.log(`📁 日志: ${logFile}`);
  return result;
}

main().catch(console.error);
