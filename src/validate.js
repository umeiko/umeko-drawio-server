import { XMLParser, XMLValidator } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
});

const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

// draw.io XML “编译”检查：XML 语法 + mxGraph 结构（mxfile/diagram/mxGraphModel/root/mxCell 0、1）
export function validateDiagramXml(xml) {
  const errors = [];
  const warnings = [];

  if (typeof xml !== 'string' || xml.trim() === '') {
    return { ok: false, errors: ['XML 为空'], warnings };
  }

  const v = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (v !== true) {
    return {
      ok: false,
      errors: [`XML 语法错误: ${v.err.msg} (line ${v.err.line}, col ${v.err.col})`],
      warnings,
    };
  }

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    return { ok: false, errors: [`XML 解析失败: ${e.message}`], warnings };
  }

  let model = null;
  if (doc.mxfile !== undefined) {
    const diagrams = asArray(doc.mxfile && doc.mxfile.diagram);
    if (diagrams.length === 0) errors.push('<mxfile> 内没有 <diagram>');
    diagrams.forEach((d, i) => {
      const inner =
        d && typeof d === 'object'
          ? d.mxGraphModel !== undefined
            ? d.mxGraphModel
            : d['#text']
          : d;
      if (inner && typeof inner === 'object') {
        if (model === null) model = inner;
      } else if (typeof inner === 'string' && inner.trim() !== '') {
        warnings.push(`diagram[${i}] 为压缩内容，已跳过其结构校验`);
      } else {
        errors.push(`diagram[${i}] 缺少 <mxGraphModel>`);
      }
    });
  } else if (doc.mxGraphModel !== undefined) {
    model = doc.mxGraphModel;
  } else {
    errors.push('根元素必须是 <mxfile> 或 <mxGraphModel>');
  }

  if (model) {
    if (!model.root) {
      errors.push('<mxGraphModel> 缺少 <root>');
    } else {
      const cells = asArray(model.root.mxCell);
      const ids = new Set(cells.map((c) => c && c['@_id']).filter((x) => x !== undefined));
      for (const required of ['0', '1']) {
        if (!ids.has(required)) errors.push(`<root> 缺少必需的 mxCell id="${required}"`);
      }
      for (const c of cells) {
        const parent = c && c['@_parent'];
        if (parent !== undefined && !ids.has(parent)) {
          warnings.push(`mxCell id="${c && c['@_id']}" 的 parent="${parent}" 不存在`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
