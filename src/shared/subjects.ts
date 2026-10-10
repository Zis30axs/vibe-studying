import type { QuestionKind, Subject } from './types'

export const subjects = ['chinese', 'math', 'english', 'politics', 'history', 'geography'] as const
export const subjectLabel: Record<Subject, string> = {
  chinese: '语文',
  math: '数学',
  english: '英语',
  politics: '思想政治',
  history: '历史',
  geography: '地理',
}
export const kindLabel: Record<QuestionKind, string> = {
  choice: '单项选择',
  chinese: '阅读与表达',
  math: '推导与解答',
  english: '阅读与写作',
  politics: '模块论证',
  history: '史料分析',
  geography: '绘图探究',
}
export const subjectGuidance: Record<
  Subject,
  { label: string; placeholder: string; local: string; review: string }
> = {
  chinese: {
    label: '阅读分析 / 表达作答',
    placeholder: '先提出判断，再引用材料中的词句，解释表达效果；写作题请按任务完整表达。',
    local: '规则只检查提示词覆盖，不判断修辞分析、立意、结构或表达质量。',
    review:
      '语文：阅读题结合具体词句解释含义和表达效果，允许有依据的不同解读；写作题关注任务、立意、组织和表达，不套用未提供的官方作文等级。',
  },
  math: {
    label: '解题步骤与结论',
    placeholder: '列出已知条件、公式、推导步骤和结论。可用 x^2、sqrt(x)、a/b 等纯文本记号。',
    local: '规则只检查提示词覆盖，不计算公式、不验证等式或推导正确性。',
    review:
      '数学：核对条件、定义域、计算、推导步骤和结论；接受等价表达和合理的不同解法。依据 rubric 给步骤分，不因出现结论关键词就判满分。',
  },
  english: {
    label: 'English answer / 英语作答',
    placeholder:
      'Answer in English. For reading, use evidence from the passage. For writing, address the task and organize your ideas.',
    local: '规则只检查英文词语覆盖，不评价语法、拼写、语篇连贯或写作质量。词数仅供参考。',
    review:
      '英语：阅读依据所给原文，写作检查任务完成、组织、语法和词汇；反馈用中文，引用或改写英文时保留英文。区分语言错误与内容错误，不把同义表达机械判错，不编造词数要求。',
  },
  politics: {
    label: '文字说明与补充',
    placeholder: '写下你的分析、材料依据与结论…',
    local: '规则只检查提示词覆盖，不理解否定、论证逻辑或模块顺序。',
    review: '政治：对应原理、材料和分析，核查概念及论证关系，不以堆砌关键词代替结合材料。',
  },
  history: {
    label: '史料依据与历史解释',
    placeholder: '区分材料所述与自己的推论，结合时间背景，按“观点—史料—解释”组织答案。',
    local: '规则只检查提示词覆盖，不验证史实、时间顺序、因果关系或史料可信度。',
    review:
      '历史：区分史料事实和推论，关注时序、历史背景、证据与解释，避免单因决定论；材料不足时明确限度，不虚构出处或史实。',
  },
  geography: {
    label: '文字说明与补充',
    placeholder: '写下你的分析、材料依据与结论…',
    local: '绘图已随作答保存，但未参与自动评分；规则不判断图形或地理因果关系。',
    review:
      '地理：联系位置、空间分布和地理过程解释；绘图只能按结构化坐标与连线核查，不能声称看到图片。',
  },
}
