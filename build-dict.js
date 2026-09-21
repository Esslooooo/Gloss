const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, 'dict');
const OUTPUT_DIR = path.join(__dirname, 'dict-parts');
const MAX_FILE_SIZE = 18 * 1024 * 1024;
const FILE_START = 1;
const FILE_END = 608;

function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error('找不到 dict/ 目录');
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
  } else {
    fs.readdirSync(OUTPUT_DIR).forEach(f => {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(OUTPUT_DIR, f));
    });
  }

  let buffer = '';
  let size = 0;
  let partIndex = 1;
  let totalEntries = 0;
  let totalBytes = 0;
  let skipped = 0;

  function flush() {
    if (size === 0) return;
    const fileName = 'part_' + String(partIndex).padStart(2, '0') + '.json';
    fs.writeFileSync(path.join(OUTPUT_DIR, fileName), buffer);
    console.log('  已写出 ' + fileName + '  (' + (size / 1024 / 1024).toFixed(1) + ' MB)');
    partIndex++;
    buffer = '';
    size = 0;
  }

  console.log('开始合并 608 个分片...\n');
  const startTime = Date.now();

  for (let i = FILE_START; i <= FILE_END; i++) {
    const fileName = String(i).padStart(4, '0') + '.json';
    const filePath = path.join(SOURCE_DIR, fileName);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const filtered = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (!entry || !entry.word) { skipped++; continue; }

        const w = entry.word;

        // 过滤 1：不能有空格（只保留单词，不要短语）
        if (w.indexOf(' ') !== -1) { skipped++; continue; }

        // 过滤 2：长度不超过 15 个字符
        if (w.length > 15) { skipped++; continue; }

        // 过滤 3：只含字母和连字符、撇号、点
        if (/[^a-zA-Z\-'.]/.test(w)) { skipped++; continue; }

        // 过滤 4：首字母必须是小写字母（排除专有名词如 Python、Apple）
        if (!/^[a-z]/.test(w)) { skipped++; continue; }

        // 过滤 5：必须有中文翻译
        if (!entry.translation || !entry.translation.length) { skipped++; continue; }

        filtered.push(trimmed);
      } catch (e) {
        skipped++;
      }
    }

    if (filtered.length === 0) continue;
    totalEntries += filtered.length;

    const chunk = filtered.join('\n') + '\n';

    if (size + chunk.length > MAX_FILE_SIZE && size > 0) {
      flush();
    }

    buffer += chunk;
    size += chunk.length;
    totalBytes += chunk.length;
  }

  flush();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n合并完成');
  console.log('   保留词条: ' + totalEntries.toLocaleString());
  console.log('   过滤掉:   ' + skipped.toLocaleString());
  console.log('   总大小:   ' + (totalBytes / 1024 / 1024).toFixed(1) + ' MB');
  console.log('   分片数:   ' + (partIndex - 1));
  console.log('   耗时:     ' + elapsed + 's');
}

main();