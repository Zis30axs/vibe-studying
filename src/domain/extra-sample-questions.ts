// All passages and scenarios below are original teaching demonstrations.
export const extraSampleQuestions = [
  {
    id: 'chi-choice-1',
    subject: 'chinese',
    kind: 'choice',
    title: '雨后小巷的修辞',
    prompt: '阅读原创句子：“雨停了，屋檐还在轻轻地数着水滴。”其中“数着”主要运用了哪种修辞？',
    choices: [
      {
        id: 'A',
        text: '比喻',
      },
      {
        id: 'B',
        text: '拟人',
      },
      {
        id: 'C',
        text: '夸张',
      },
      {
        id: 'D',
        text: '排比',
      },
    ],
    correctAnswer: 'B',
    explanation:
      '把屋檐写得像人一样能够“数”水滴，赋予其人的动作，属于拟人。没有把两个事物作相似性比较，不能仅因语言生动就判为比喻。',
    tags: ['修辞', '语言赏析'],
    maxScore: 4,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'chi-reading-1',
    subject: 'chinese',
    kind: 'chinese',
    title: '旧书摊前的停留',
    prompt:
      '【原创片段】放学路上，我总匆匆经过旧书摊。那天，摊主把一本卷了角的书递给我：“慢慢翻，不急。”街口的车流还在奔跑，我却第一次听见纸页翻动的沙沙声。\n\n问题：结尾把“车流奔跑”和“纸页的沙沙声”写在一起，有什么表达效果？请结合片段分析。',
    rubric: [
      {
        id: 'point-1',
        label: '指出外部匆忙与内心安静形成对比',
        keywords: ['对比', '反衬', '衬托'],
        points: 2,
      },
      {
        id: 'point-2',
        label: '引用或概括纸页声音这一细节',
        keywords: ['纸页', '沙沙声'],
        points: 2,
      },
      {
        id: 'point-3',
        label: '联系人物从匆忙到专注的变化',
        keywords: ['专注', '慢下来', '安静', '停留'],
        points: 2,
      },
    ],
    explanation:
      '参考思路：车流的匆忙与翻书时感受到的细微声音形成对比，突出“我”慢下来后的专注与安静，也表现摊主的耐心带来的影响。可接受其他有文本依据的解读；只说“生动形象”而不联系细节不够充分。',
    tags: ['现代文阅读', '表达效果'],
    maxScore: 6,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'chi-writing-1',
    subject: 'chinese',
    kind: 'chinese',
    title: '为校园阅读角提建议',
    prompt:
      '【原创任务】学校准备把一间闲置教室改成阅读角。请写一段建议，提出一项具体措施，说明它如何改善同学的阅读体验，并指出实施时需要注意的问题。建议约 150 字，字数不参与本地自动评分。',
    rubric: [
      {
        id: 'point-1',
        label: '提出可实施的阅读措施',
        keywords: ['书架', '借阅', '座位', '书目', '开放时间'],
        points: 3,
      },
      {
        id: 'point-2',
        label: '说明措施与阅读体验的关系',
        keywords: ['因为', '便于', '方便', '有助于', '从而'],
        points: 3,
      },
      {
        id: 'point-3',
        label: '考虑实施约束或维护',
        keywords: ['维护', '归还', '安静', '管理', '空间'],
        points: 2,
      },
    ],
    explanation:
      '示例思路：设置按主题分类的书架和简明借阅登记，方便同学找到需要的书；安排值日维护并提醒及时归还。答案可以采取不同措施，重点是措施具体、理由明确、约束现实。关键词规则不能评价整段建议的质量。',
    tags: ['实用表达', '建议'],
    maxScore: 8,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'math-choice-1',
    subject: 'math',
    kind: 'choice',
    title: '一次函数的变化',
    prompt: '已知 y = 2x - 3，当 x 从 1 增加到 4 时，y 增加了多少？',
    choices: [
      {
        id: 'A',
        text: '3',
      },
      {
        id: 'B',
        text: '5',
      },
      {
        id: 'C',
        text: '6',
      },
      {
        id: 'D',
        text: '8',
      },
    ],
    correctAnswer: 'C',
    explanation:
      '函数斜率为 2，x 的增量为 4 - 1 = 3，因此 y 的增量为 2 × 3 = 6。也可分别代入求值后相减。',
    tags: ['一次函数', '变化量'],
    maxScore: 4,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'math-solution-1',
    subject: 'math',
    kind: 'math',
    title: '解一元一次方程',
    prompt:
      '【原创题】解方程 3(x - 2) = 2x + 5。请写出变形步骤，并把结果代回原式检验。可使用纯文本公式。',
    rubric: [
      {
        id: 'point-1',
        label: '展开括号',
        keywords: ['3x - 6', '3x-6', '3*x-6'],
        points: 2,
      },
      {
        id: 'point-2',
        label: '移项求得 x = 11',
        keywords: ['x = 11', 'x=11'],
        points: 2,
      },
      {
        id: 'point-3',
        label: '代回检验左右均为 27',
        keywords: ['27'],
        points: 2,
      },
    ],
    explanation:
      '3x - 6 = 2x + 5，移项得 x = 11。代入左边 3(11 - 2) = 27，右边 2 × 11 + 5 = 27，两边相等。本地规则只识别列出的文本提示，空格或等价写法可能漏判，也不能检测错误推导。',
    tags: ['方程', '检验'],
    maxScore: 6,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'math-probability-1',
    subject: 'math',
    kind: 'math',
    title: '摸球事件的概率',
    prompt:
      '【原创题】袋中有 3 个红球和 2 个蓝球，除颜色外完全相同。充分混合后随机摸出 1 个球。求摸到红球的概率，并说明理由。',
    rubric: [
      {
        id: 'point-1',
        label: '说明共有五个等可能结果',
        keywords: ['5', '五'],
        points: 2,
      },
      {
        id: 'point-2',
        label: '说明有三个红球对应结果',
        keywords: ['3', '三'],
        points: 2,
      },
      {
        id: 'point-3',
        label: '给出红球概率',
        keywords: ['3/5', '0.6', '60%'],
        points: 2,
      },
    ],
    explanation:
      '共有 5 个等可能被摸到的球，其中 3 个为红球，所以 P(红球) = 3/5 = 0.6。可用“满足条件的结果数 / 所有等可能结果数”解释。仅写数字不能证明推理正确，请核对完整步骤。',
    tags: ['概率', '等可能性'],
    maxScore: 6,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'eng-choice-1',
    subject: 'english',
    kind: 'choice',
    title: 'A changed journey',
    prompt:
      'Read the original passage: “Maya used to take the bus to school. This week she started cycling because the new bike path makes the journey safer.” Why did Maya change how she travels?',
    choices: [
      {
        id: 'A',
        text: 'The bus became free.',
      },
      {
        id: 'B',
        text: 'A new path made cycling safer.',
      },
      {
        id: 'C',
        text: 'Her school moved closer.',
      },
      {
        id: 'D',
        text: 'She lost her bus card.',
      },
    ],
    correctAnswer: 'B',
    explanation: '原文 because 后直接说明原因：新的自行车道提高了安全性。其余选项没有原文依据。',
    tags: ['阅读理解', '细节信息'],
    maxScore: 4,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'eng-reading-1',
    subject: 'english',
    kind: 'english',
    title: 'A library experiment',
    prompt:
      '【Original passage】Our library moved a small shelf of books near the entrance. More students stopped to browse, but the number of books borrowed did not rise. The librarian decided to ask students which books they wanted.\n\nIn English, explain what changed and why the librarian planned to ask students. Use evidence from the passage.',
    rubric: [
      {
        id: 'point-1',
        label: '指出更多学生停下浏览',
        keywords: ['browse', 'browsing', 'stopped'],
        points: 2,
      },
      {
        id: 'point-2',
        label: '说明借阅量没有上升',
        keywords: ['borrowed', 'borrowing', 'loans'],
        points: 2,
      },
      {
        id: 'point-3',
        label: '说明了解学生的阅读需求',
        keywords: ['wanted', 'want', 'interests', 'preferences'],
        points: 2,
      },
    ],
    explanation:
      'Possible answer: More students stopped to browse, but borrowing did not increase. The librarian wanted to learn about students’ interests so the library could offer books they wanted. 原文未证明书架调整提高了借阅量。可接受有依据的同义表达，本地词语检查不会判断否定或因果关系。',
    tags: ['阅读理解', '证据与推断'],
    maxScore: 6,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'eng-writing-1',
    subject: 'english',
    kind: 'english',
    title: 'Invite a friend to a reading event',
    prompt:
      '【Original task】Write an email to your friend Alex inviting them to a school reading event. Mention that it is on Friday at 4 p.m. in the school library. Suggest bringing a favorite book and explain why you would like Alex to join. Aim for 60–80 words; this is a practice target, not an automatic scoring rule.',
    rubric: [
      {
        id: 'point-1',
        label: '交代时间与地点',
        keywords: ['Friday', 'library'],
        points: 3,
      },
      {
        id: 'point-2',
        label: '邀请对方并提出带书建议',
        keywords: ['invite', 'join', 'bring'],
        points: 3,
      },
      {
        id: 'point-3',
        label: '说明共同参与的理由',
        keywords: ['share', 'discuss', 'together', 'because'],
        points: 2,
      },
    ],
    explanation:
      'One possible opening: Dear Alex, Would you like to join our reading event in the school library at 4 p.m. on Friday? Please bring a favorite book so we can share our ideas. 完整邮件还应给出参与理由与适当结尾。时间、地点、邀请、带书建议应分别核对；本地命中一词不代表整个评分项已完成，也不评价语法。',
    tags: ['应用文写作', '邀请邮件'],
    maxScore: 8,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'hist-choice-1',
    subject: 'history',
    kind: 'choice',
    title: '观察史料的边界',
    prompt:
      '【原创情境】某研究者发现一份工厂档案，记录某一年该厂引进了两台机器。仅据这份档案，最稳妥的结论是什么？',
    choices: [
      {
        id: 'A',
        text: '当时所有工厂都已实现机械化。',
      },
      {
        id: 'B',
        text: '该厂在档案所记年份引进了机器。',
      },
      {
        id: 'C',
        text: '手工业已在全国完全消失。',
      },
      {
        id: 'D',
        text: '机器引进必然改善了所有工人的生活。',
      },
    ],
    correctAnswer: 'B',
    explanation:
      '史料支持的是特定工厂在特定时间引进机器，不能直接推广到全国，也不能仅凭机器数量推断所有人的生活状况。',
    tags: ['史料实证', '证据边界'],
    maxScore: 4,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'hist-source-1',
    subject: 'history',
    kind: 'history',
    title: '从两则记录认识交通变化',
    prompt:
      '【教学用原创模拟史料，非真实档案摘录】同一城镇的两则记录：甲记载旧时商人多借河道运货，遇枯水常延误；乙记载后来铁路通车后，商人开始把部分货物改用火车运输。\n\n根据材料概括运输方式的变化，分析一种可能的影响，并说明仅凭材料尚不能确定什么。',
    rubric: [
      {
        id: 'point-1',
        label: '概括水运向水陆并用的变化',
        keywords: ['铁路', '火车'],
        points: 2,
      },
      {
        id: 'point-2',
        label: '提出有条件的运输或市场影响',
        keywords: ['效率', '时间', '市场', '运输'],
        points: 2,
      },
      {
        id: 'point-3',
        label: '说明证据有限，避免过度推断',
        keywords: ['不能', '不足', '还需', '无法'],
        points: 2,
      },
    ],
    explanation:
      '可概括为从主要依赖河运转向水陆运输并用。铁路可能减少对水位的依赖、改善运输效率或扩大市场联系，但材料不足以确定运费变化、实际运量或所有居民是否受益，需要更多资料。模拟材料不对应特定真实事件。',
    tags: ['史料分析', '交通与社会'],
    maxScore: 6,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
  {
    id: 'hist-explanation-1',
    subject: 'history',
    kind: 'history',
    title: '区分历史解释与单一因果',
    prompt:
      '【教学用原创情境，非真实档案摘录】某地区的新式学校逐渐增多，同时出现报刊传播、城市人口增加等现象。有同学说：“新式学校增多完全是报刊推动的。”\n\n请指出这一解释的不足，并说明应如何进一步研究。不要把情境当成某一真实地区的史实。',
    rubric: [
      {
        id: 'point-1',
        label: '指出单一原因或相关不等于因果',
        keywords: ['单一', '多种', '不能', '不等于'],
        points: 2,
      },
      {
        id: 'point-2',
        label: '提出考察其他背景因素',
        keywords: ['经济', '人口', '政策', '需求'],
        points: 2,
      },
      {
        id: 'point-3',
        label: '提出补充并比较证据',
        keywords: ['比较', '档案', '资料', '证据', '时间'],
        points: 2,
      },
    ],
    explanation:
      '这一说法把同时出现的现象直接认定为唯一因果。研究应结合经济、人口、政策或教育需求等背景，补充不同时间和地区的档案、统计等证据进行比较，再判断报刊的作用及限度。允许其他合理研究路径。',
    tags: ['历史解释', '因果分析'],
    maxScore: 6,
    source: 'ExamCraft 原创示例 · 非历年真题',
  },
]
