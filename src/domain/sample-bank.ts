import { questionBankSchema } from './schemas'
import { extraSampleQuestions } from './extra-sample-questions'

export const SAMPLE_SOURCE = 'ExamCraft 原创示例 · 非历年真题'
export const sampleQuestions = questionBankSchema.parse({
  version: 1,
  questions: [
    {
      id: 'pol-choice-1',
      subject: 'politics',
      kind: 'choice',
      title: '从实践中发现问题',
      prompt:
        '某社区先走访居民了解需求，再调整公共空间改造方案，并通过试点检验效果。这一做法主要体现了什么？',
      source: SAMPLE_SOURCE,
      tags: ['认识论', '实践'],
      maxScore: 4,
      choices: [
        { id: 'A', text: '实践是认识的来源，也是检验认识真理性的唯一标准' },
        { id: 'B', text: '认识一旦形成就不再变化' },
        { id: 'C', text: '主观愿望直接决定客观结果' },
        { id: 'D', text: '获得认识不需要接触实际' },
      ],
      correctAnswer: 'A',
      explanation:
        '走访从实践中取得认识，试点又以实践检验方案。认识会随实践的发展不断深化，不能用主观愿望代替客观条件。',
    },
    {
      id: 'pol-choice-2',
      subject: 'politics',
      kind: 'choice',
      title: '一把钥匙开一把锁',
      prompt:
        '不同村庄根据各自的地形、资源和人口结构制定发展方案，避免照搬同一种模式。这主要体现了：',
      source: SAMPLE_SOURCE,
      tags: ['辩证法', '矛盾'],
      maxScore: 4,
      choices: [
        { id: 'A', text: '所有矛盾都具有完全相同的特点' },
        { id: 'B', text: '坚持具体问题具体分析' },
        { id: 'C', text: '只要有愿望就能改变规律' },
        { id: 'D', text: '忽视事物之间的联系' },
      ],
      correctAnswer: 'B',
      explanation:
        '矛盾具有特殊性，要求具体问题具体分析。针对资源、地形等差异制定方案，才能找到适合当地的解决方法。',
    },
    {
      id: 'pol-assembly-1',
      subject: 'politics',
      kind: 'politics',
      title: '让社区更新回应居民需求',
      prompt:
        '【材料】某社区更新闲置广场前，组织居民议事会、实地走访并收集意见；先试点增设无障碍设施，再根据使用反馈优化方案。\n\n请运用认识论相关知识，说明社区如何形成并完善改造方案。可以按“原理—材料—分析—结论”组装答案，再补充自己的论证。',
      source: SAMPLE_SOURCE,
      tags: ['认识论', '实践', '主观题'],
      maxScore: 12,
      blocks: [
        {
          id: 'principle-practice',
          category: 'principle',
          label: '原理 · 实践与认识',
          text: '实践是认识的来源，也是检验认识真理性的唯一标准。',
        },
        {
          id: 'material-survey',
          category: 'material',
          label: '材料 · 调查需求',
          text: '社区通过居民议事会和实地走访，调查居民的实际需求。',
        },
        {
          id: 'analysis-feedback',
          category: 'analysis',
          label: '分析 · 在试点中检验',
          text: '通过试点和使用反馈检验改造方案，并在实践中不断完善认识。',
        },
        {
          id: 'conclusion-improve',
          category: 'conclusion',
          label: '结论 · 持续优化',
          text: '坚持从实际出发，使方案在实践与认识的循环中不断优化。',
        },
        {
          id: 'principle-distractor',
          category: 'principle',
          label: '待辨析 · 认识固定不变',
          text: '只要形成最初方案，就不需要再根据实践调整。',
        },
      ],
      rubric: [
        {
          id: 'source',
          label: '点明实践与认识的关系',
          keywords: ['实践是认识的来源', '实践决定认识'],
          points: 4,
        },
        {
          id: 'survey',
          label: '结合调查居民需求的材料',
          keywords: ['走访', '议事会', '调查'],
          points: 4,
        },
        {
          id: 'feedback',
          label: '说明试点检验与完善方案',
          keywords: ['检验', '完善', '优化'],
          points: 4,
        },
      ],
      explanation:
        '参考思路：先说明实践与认识的关系；再把走访、议事会对应到获取认识；最后用试点及反馈说明实践检验认识、推动认识发展。模块顺序有助于组织表达，但关键词命中不能证明论证正确。',
    },
    {
      id: 'geo-choice-1',
      subject: 'geography',
      kind: 'choice',
      title: '经纬网中的方向',
      prompt:
        '甲地位于（20°E，30°N），乙地位于（40°E，50°N）。在不跨越经度 180°的经纬网中，乙地位于甲地的什么方向？',
      source: SAMPLE_SOURCE,
      tags: ['经纬网', '方向'],
      maxScore: 4,
      choices: [
        { id: 'A', text: '西南方向' },
        { id: 'B', text: '东南方向' },
        { id: 'C', text: '东北方向' },
        { id: 'D', text: '西北方向' },
      ],
      correctAnswer: 'C',
      explanation: '乙地东经度更大，位于甲地以东；北纬度更大，位于甲地以北，所以是东北方向。',
    },
    {
      id: 'geo-choice-2',
      subject: 'geography',
      kind: 'choice',
      title: '等高线与坡度',
      prompt: '在同一幅等高距相同的等高线地形图中，其他条件相同，等高线越密集的区域通常：',
      source: SAMPLE_SOURCE,
      tags: ['地形图', '等高线'],
      maxScore: 4,
      choices: [
        { id: 'A', text: '坡度越陡' },
        { id: 'B', text: '坡度越缓' },
        { id: 'C', text: '海拔一定越低' },
        { id: 'D', text: '一定为盆地' },
      ],
      correctAnswer: 'A',
      explanation:
        '等高距相同，相邻等高线之间水平距离越短，单位水平距离内的高差越大，坡度越陡。密度不能单独判断海拔高低或地形类型。',
    },
    {
      id: 'geo-drawing-1',
      subject: 'geography',
      kind: 'geography',
      title: '在经纬网中定位与连线',
      prompt:
        '切换到经纬网模式，标出 A（20°E，30°N）和 B（40°E，50°N），连成线段。用文字说明 B 相对 A 的方向，并说明你如何判断。\n\n这是坐标练习；平面连线不代表球面最短航线。绘图会随答案保存，当前规则只检查文字关键词，不判定图形正误。',
      source: SAMPLE_SOURCE,
      tags: ['经纬网', '方向', '绘图'],
      maxScore: 6,
      rubric: [
        { id: 'direction', label: '指出东北方向', keywords: ['东北'], points: 2 },
        { id: 'longitude', label: '用经度解释东西方向', keywords: ['东经', '经度'], points: 2 },
        { id: 'latitude', label: '用纬度解释南北方向', keywords: ['北纬', '纬度'], points: 2 },
      ],
      explanation:
        'A 的坐标为（20，30），B 为（40，50）。两点均在东经、北纬范围内，B 的经度和纬度都更大，因此位于 A 的东北方向。请自行核对图上的点和连线；本地规则未对绘图评分。',
    },
    ...extraSampleQuestions,
  ],
}).questions
