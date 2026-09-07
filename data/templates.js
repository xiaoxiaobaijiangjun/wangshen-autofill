// 预置字段模板 + 同义词表（detector 与页面共用；作为 content script 先于 detector.js 加载）
// 挂载到 globalThis.WangshenTemplates，无模块系统依赖。
(function (global) {
  'use strict';

  // ============ 工具 ============

  // label 归一化：去空格/冒号/星号/必填标记/请输入提示，转小写
  function normalizeLabel(raw) {
    if (!raw) return '';
    return String(raw)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[：:*＊·、，,。.()（）\[\]【】\-—_~]+/g, '')
      .replace(/必填|选填|请输入|请选择|please(select|input|enter)/g, '')
      .trim();
  }

  function isRegexPattern(p) {
    return p.indexOf('re:') === 0;
  }

  // 对单个字段组评分：精确=1.0，正则全匹配=0.95，包含=0.75，正则普通命中=0.7
  function scoreGroup(normLabel, patterns) {
    let best = 0;
    for (const p of patterns) {
      if (isRegexPattern(p)) {
        const re = new RegExp(p.slice(3), 'i');
        if (re.test(normLabel)) {
          const m = normLabel.match(re);
          const full = m && m[0] === normLabel;
          best = Math.max(best, full ? 0.95 : 0.7);
        }
      } else if (normLabel === p) {
        best = Math.max(best, 1.0);
      } else if (p.length >= 2 && (normLabel.includes(p) || normLabel.length >= 2 && p.includes(normLabel))) {
        best = Math.max(best, 0.75);
      }
    }
    return best;
  }

  // ============ 同义词表（60 组，覆盖两套模板全部字段 + 常见扩展字段） ============
  // material:true 的字段是「开放题素材」，不参与表单匹配，仅供 AI 起草引用。
  const SYNONYMS = [
    // —— 基本信息（互联网短表单） ——
    { key: 'name', patterns: ['姓名', '名字', '学生姓名', '申请人姓名', 're:(full|real)?name'] },
    { key: 'gender', patterns: ['性别', 're:gender|sex'] },
    { key: 'birthDate', patterns: ['出生日期', '出生年月', '生日', 're:date.?of.?birth|birthday'] },
    { key: 'phone', patterns: ['手机', '手机号', '手机号码', '电话', '联系电话', '联系方式', 're:(mobile|phone|tel|cell)'] },
    { key: 'email', patterns: ['邮箱', '电子邮箱', '邮箱地址', '邮件地址', '电子邮件', 're:e.?mail'] },
    { key: 'idCard', patterns: ['身份证', '身份证号', '身份证号码', '证件号码', 're:id.?card|idnumber'] },
    { key: 'currentCity', patterns: ['现居城市', '所在城市', '现居住地', '居住地', '现居住城市', '现所在地', '联系地址', 're:city|address|location'] },

    // —— 教育背景 ——
    { key: 'school', patterns: ['毕业院校', '学校', '院校', '毕业学校', '就读院校', '所在学校', 're:school|university|college'] },
    { key: 'major', patterns: ['专业', '所学专业', '专业名称', 're:major'] },
    { key: 'degree', patterns: ['学历', '最高学历', '学历层次', 're:degree|education'] },
    { key: 'graduationDate', patterns: ['毕业时间', '预计毕业时间', '毕业年月', '毕业日期', 're:graduat'] },
    { key: 'gpa', patterns: ['gpa', '绩点', '成绩排名', '平均绩点', 're:gpa|gradepoint'] },
    { key: 'englishLevel', patterns: ['英语水平', '英语能力', '外语水平', 're:english'] },

    // —— 求职意向 ——
    { key: 'expectedPosition', patterns: ['应聘岗位', '期望岗位', '求职岗位', '应聘职位', '期望职位', '意向岗位', '意向职位', 're:position|expectedjob|expectedrole'] },
    { key: 'expectedCity', patterns: ['期望工作城市', '期望城市', '意向城市', '工作城市', '期望工作地点', '意向工作地', '工作地点', '期望地点', 're:(expected|preferred).?city|preferred.?location'] },
    { key: 'expectedSalary', patterns: ['期望薪资', '薪资期望', '期望工资', '薪资要求', '待遇要求', 're:salary|compensation'] },
    { key: 'availableTime', patterns: ['可到岗时间', '到岗时间', '可入职时间', '入职时间', '最早到岗时间', 're:available|onboard|startwork'] },

    // —— 技能与其他 ——
    { key: 'skills', patterns: ['技能特长', '专业技能', '技能', '特长', '掌握技能', 're:skills?|abilities'] },
    { key: 'github', patterns: ['github', '个人主页', '个人主页/github', '个人网站', 're:github|homepage|personal.?website'] },
    { key: 'awards', patterns: ['获奖情况', '荣誉奖项', '获奖经历', '所获荣誉', '奖项', 're:awards?|honou?rs?|prizes?'] },
    { key: 'selfEvaluation', patterns: ['自我评价', '个人评价', 're:self.?evaluat'] },

    // —— 开放题素材（仅 AI 引用，不参与表单匹配） ——
    { key: 'openSelfIntro', material: true, patterns: ['自我介绍'] },
    { key: 'openProject', material: true, patterns: ['项目深挖'] },
    { key: 'openMotivation', material: true, patterns: ['求职动机'] },
    { key: 'openCityPlan', material: true, patterns: ['城市意向'] },

    // —— 央国企：政治与个人情况 ——
    { key: 'politicalStatus', patterns: ['政治面貌', '政治状态', 're:political'] },
    { key: 'joinPartyDate', patterns: ['入党时间', '入党日期', 're:join.?party|party.?date'] },
    { key: 'ethnic', patterns: ['民族', 're:ethnic'] },
    { key: 'hometown', patterns: ['籍贯', '原籍', 're:native.?place|ancestral'] },
    { key: 'birthplace', patterns: ['出生地', 're:birthplace|birth.?place'] },
    { key: 'household', patterns: ['户口所在地', '户籍所在地', '户籍', '户口', 're:household|registered.?residence'] },
    { key: 'maritalStatus', patterns: ['婚姻状况', '婚否', '婚姻情况', 're:marital|marriage'] },
    { key: 'nationality', patterns: ['国籍', 're:nationality|citizenship'] },
    { key: 'height', patterns: ['身高', 're:height'] },
    { key: 'weight', patterns: ['体重', 're:weight'] },
    { key: 'healthStatus', patterns: ['健康状况', '健康状态', '身体情况', 're:health'] },

    // —— 央国企：语言与技能证书 ——
    { key: 'cet4Score', patterns: ['四级成绩', '英语四级', 'cet-4', 'cet4', '四级', '英语四级成绩', 'cet4成绩', '英语四级cet4成绩', 're:cet.?4'] },
    { key: 'cet6Score', patterns: ['六级成绩', '英语六级', 'cet-6', 'cet6', '六级', '英语六级成绩', 'cet6成绩', '英语六级cet6成绩', 're:cet.?6'] },
    { key: 'computerLevel', patterns: ['计算机等级', '计算机水平', '计算机能力', '计算机一级', '计算机二级', '计算机三级', '计算机四级', 're:computer|ncre'] },
    { key: 'mandarinLevel', patterns: ['普通话水平', '普通话等级', '普通话', 're:mandarin|putonghua'] },
    { key: 'drivingLicense', patterns: ['驾驶证', '驾照', '机动车驾驶证', 're:driver.?license|driving.?licence|驾照'] },

    // —— 央国企：家庭与紧急联系 ——
    { key: 'familyName1', sensitive: true, patterns: ['家庭成员姓名', '成员一姓名', '家庭成员1姓名', '父亲姓名', '母亲姓名', 're:family.{0,4}1.{0,4}name|member.?1.?name'] },
    { key: 'familyRelation1', patterns: ['与本人关系', '称谓', '成员一称谓', 're:family.{0,4}1.{0,4}(relation|ship)|member.?1.?(relation)'] },
    { key: 'familyUnit1', sensitive: true, patterns: ['家庭成员工作单位', '父母工作单位', '成员一工作单位', '家庭成员1工作单位', 're:(family|成员|父母|家长).{0,6}(单位|职务|职业)'] },
    { key: 'familyName2', sensitive: true, patterns: ['成员二姓名', '家庭成员2姓名', 're:family.{0,4}2.{0,4}name|member.?2.?name'] },
    { key: 'familyRelation2', patterns: ['成员二称谓', 're:family.{0,4}2.{0,4}(relation|ship)|member.?2.?(relation)'] },
    { key: 'familyUnit2', sensitive: true, patterns: ['成员二工作单位', '家庭成员2工作单位', 're:family.{0,4}2.{0,6}(单位|职务|unit|employ)'] },
    { key: 'emergencyName', sensitive: true, patterns: ['紧急联系人', '应急联系人', 're:emergency.*(contact|person)|emergencyname'] },
    { key: 'emergencyPhone', sensitive: true, patterns: ['紧急联系电话', '紧急联系方式', '紧急联系人电话', 're:emergency.*(phone|tel|mobile|number)'] },

    // —— 央国企：补充声明 ——
    { key: 'punishment', patterns: ['奖惩情况', '奖惩', '奖励与处分', '受奖惩情况', 're:reward|punish|discipline'] },
    { key: 'medicalHistory', sensitive: true, patterns: ['体检史', '病史', '健康状况说明', '体检情况', 're:medical.?history|illness|disease'] },

    // —— 扩展同义词（模板之外，用户可按需加为自定义字段） ——
    { key: 'age', patterns: ['年龄', 're:age'] },
    { key: 'wechat', patterns: ['微信', '微信号', 're:wechat|weixin'] },
    { key: 'qq', patterns: ['qq', 'qq号', 're:qq'] },
    { key: 'blog', patterns: ['博客', 're:blog'] },
    { key: 'portfolio', patterns: ['作品集', '作品集链接', 're:portfolio'] },
    { key: 'workYears', patterns: ['工作年限', '工作经验', 're:work.?years?|workexp'] },
    { key: 'referrer', patterns: ['内推人', '推荐人', 're:refer{2}er'] },
    { key: 'idType', patterns: ['证件类型', '证件种类', 're:id.?type|idtype'] },
    { key: 'workUnit', patterns: ['工作单位', '单位名称', '实习单位', 're:(work)?unit|employer|company'] },
  ];

  // ============ 模板字段 ============
  // 字段结构：{ key, label, group, inputType: text|textarea|select, options?, sensitive, autoFill, patterns }

  const SHORT_FORM_TEMPLATE = [
    { key: 'name', label: '姓名', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['姓名', '名字', '学生姓名', '申请人姓名', 're:(full|real)?name'] },
    { key: 'gender', label: '性别', group: '基本信息', inputType: 'select', options: ['男', '女'], sensitive: false, autoFill: true, patterns: ['性别', 're:gender|sex'] },
    { key: 'birthDate', label: '出生日期', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['出生日期', '出生年月', '生日', 're:date.?of.?birth|birthday'] },
    { key: 'phone', label: '手机号', group: '基本信息', inputType: 'text', sensitive: true, autoFill: true, patterns: ['手机', '手机号', '手机号码', '电话', '联系电话', '联系方式', 're:(mobile|phone|tel|cell)'] },
    { key: 'email', label: '邮箱', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['邮箱', '电子邮箱', '邮箱地址', '邮件地址', '电子邮件', 're:e.?mail'] },
    { key: 'idCard', label: '身份证号', group: '基本信息', inputType: 'text', sensitive: true, autoFill: true, patterns: ['身份证', '身份证号', '身份证号码', '证件号码', 're:id.?card|idnumber'] },
    { key: 'currentCity', label: '现居城市', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['现居城市', '所在城市', '现居住地', '居住地', '现居住城市', '现所在地', '联系地址', 're:city|address|location'] },
    { key: 'school', label: '毕业院校', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['毕业院校', '学校', '院校', '毕业学校', '就读院校', '所在学校', 're:school|university|college'] },
    { key: 'major', label: '专业', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['专业', '所学专业', '专业名称', 're:major'] },
    { key: 'degree', label: '学历', group: '教育背景', inputType: 'select', options: ['博士', '硕士', '本科', '大专', '其他'], sensitive: false, autoFill: true, patterns: ['学历', '最高学历', '学历层次', 're:degree|education'] },
    { key: 'graduationDate', label: '毕业时间', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['毕业时间', '预计毕业时间', '毕业年月', '毕业日期', 're:graduat'] },
    { key: 'gpa', label: 'GPA/成绩排名', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['gpa', '绩点', '成绩排名', '平均绩点', 're:gpa|gradepoint'] },
    { key: 'englishLevel', label: '英语水平', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['英语水平', '英语能力', '外语水平', 're:english'] },
    { key: 'expectedPosition', label: '应聘岗位', group: '求职意向', inputType: 'text', sensitive: false, autoFill: true, patterns: ['应聘岗位', '期望岗位', '求职岗位', '应聘职位', '期望职位', '意向岗位', '意向职位', 're:position|expectedjob|expectedrole'] },
    { key: 'expectedCity', label: '期望工作城市', group: '求职意向', inputType: 'text', sensitive: false, autoFill: true, patterns: ['期望工作城市', '期望城市', '意向城市', '工作城市', '期望工作地点', '意向工作地', '工作地点', '期望地点', 're:(expected|preferred).?city|preferred.?location'] },
    { key: 'expectedSalary', label: '期望薪资', group: '求职意向', inputType: 'text', sensitive: true, autoFill: true, patterns: ['期望薪资', '薪资期望', '期望工资', '薪资要求', '待遇要求', 're:salary|compensation'] },
    { key: 'availableTime', label: '可到岗时间', group: '求职意向', inputType: 'text', sensitive: false, autoFill: true, patterns: ['可到岗时间', '到岗时间', '可入职时间', '入职时间', '最早到岗时间', 're:available|onboard|startwork'] },
    { key: 'skills', label: '技能特长', group: '技能与其他', inputType: 'text', sensitive: false, autoFill: true, patterns: ['技能特长', '专业技能', '技能', '特长', '掌握技能', 're:skills?|abilities'] },
    { key: 'github', label: '个人主页/GitHub', group: '技能与其他', inputType: 'text', sensitive: false, autoFill: true, patterns: ['github', '个人主页', '个人主页/github', '个人网站', 're:github|homepage|personal.?website'] },
    { key: 'awards', label: '获奖情况', group: '技能与其他', inputType: 'textarea', sensitive: false, autoFill: true, patterns: ['获奖情况', '荣誉奖项', '获奖经历', '所获荣誉', '奖项', 're:awards?|honou?rs?|prizes?'] },
    { key: 'selfEvaluation', label: '自我评价', group: '技能与其他', inputType: 'textarea', sensitive: false, autoFill: true, patterns: ['自我评价', '个人评价', 're:self.?evaluat'] },
    { key: 'openSelfIntro', label: '自我介绍（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['自我介绍'] },
    { key: 'openProject', label: '项目深挖（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['项目深挖'] },
    { key: 'openMotivation', label: '求职动机（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['求职动机'] },
    { key: 'openCityPlan', label: '城市意向（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['城市意向'] },
  ];

  const SOE_EXTRA_TEMPLATE = [
    { key: 'politicalStatus', label: '政治面貌', group: '政治与个人情况', inputType: 'select', options: ['中共党员', '中共预备党员', '共青团员', '民主党派', '群众', '其他'], sensitive: false, autoFill: true, patterns: ['政治面貌', '政治状态', 're:political'] },
    { key: 'joinPartyDate', label: '入党时间', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['入党时间', '入党日期', 're:join.?party|party.?date'] },
    { key: 'ethnic', label: '民族', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['民族', 're:ethnic'] },
    { key: 'hometown', label: '籍贯', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['籍贯', '原籍', 're:native.?place|ancestral'] },
    { key: 'birthplace', label: '出生地', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['出生地', 're:birthplace|birth.?place'] },
    { key: 'household', label: '户籍所在地', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['户口所在地', '户籍所在地', '户籍', '户口', 're:household|registered.?residence'] },
    { key: 'maritalStatus', label: '婚姻状况', group: '政治与个人情况', inputType: 'select', options: ['未婚', '已婚', '保密'], sensitive: false, autoFill: true, patterns: ['婚姻状况', '婚否', '婚姻情况', 're:marital|marriage'] },
    { key: 'nationality', label: '国籍', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['国籍', 're:nationality|citizenship'] },
    { key: 'height', label: '身高', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['身高', 're:height'] },
    { key: 'weight', label: '体重', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['体重', 're:weight'] },
    { key: 'healthStatus', label: '健康状况', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['健康状况', '健康状态', '身体情况', 're:health'] },
    { key: 'cet4Score', label: '英语四级(CET-4)', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['四级成绩', '英语四级', 'cet-4', 'cet4', '四级', '英语四级成绩', 'cet4成绩', '英语四级cet4成绩', 're:cet.?4'] },
    { key: 'cet6Score', label: '英语六级(CET-6)', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['六级成绩', '英语六级', 'cet-6', 'cet6', '六级', '英语六级成绩', 'cet6成绩', '英语六级cet6成绩', 're:cet.?6'] },
    { key: 'computerLevel', label: '计算机等级', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['计算机等级', '计算机水平', '计算机能力', '计算机一级', '计算机二级', '计算机三级', '计算机四级', 're:computer|ncre'] },
    { key: 'mandarinLevel', label: '普通话水平', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['普通话水平', '普通话等级', '普通话', 're:mandarin|putonghua'] },
    { key: 'drivingLicense', label: '机动车驾驶证', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['驾驶证', '驾照', '机动车驾驶证', 're:driver.?license|driving.?licence'] },
    { key: 'familyName1', label: '家庭成员一·姓名', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['家庭成员姓名', '成员一姓名', '家庭成员1姓名', '父亲姓名', '母亲姓名', 're:family.{0,4}1.{0,4}name|member.?1.?name'] },
    { key: 'familyRelation1', label: '家庭成员一·称谓', group: '家庭与紧急联系', inputType: 'text', sensitive: false, autoFill: true, patterns: ['与本人关系', '称谓', '成员一称谓', 're:family.{0,4}1.{0,4}relation|member.?1.?relation'] },
    { key: 'familyUnit1', label: '家庭成员一·工作单位', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['家庭成员工作单位', '父母工作单位', '成员一工作单位', '家庭成员1工作单位', 're:(family|成员|父母|家长).{0,6}(单位|职务|职业)'] },
    { key: 'familyName2', label: '家庭成员二·姓名', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['成员二姓名', '家庭成员2姓名', 're:family.{0,4}2.{0,4}name|member.?2.?name'] },
    { key: 'familyRelation2', label: '家庭成员二·称谓', group: '家庭与紧急联系', inputType: 'text', sensitive: false, autoFill: true, patterns: ['成员二称谓', 're:family.{0,4}2.{0,4}relation|member.?2.?relation'] },
    { key: 'familyUnit2', label: '家庭成员二·工作单位', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['成员二工作单位', '家庭成员2工作单位', 're:family.{0,4}2.{0,6}(单位|职务|unit|employ)'] },
    { key: 'emergencyName', label: '紧急联系人', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['紧急联系人', '应急联系人', 're:emergency.*(contact|person)|emergencyname'] },
    { key: 'emergencyPhone', label: '紧急联系电话', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['紧急联系电话', '紧急联系方式', '紧急联系人电话', 're:emergency.*(phone|tel|mobile|number)'] },
    { key: 'punishment', label: '奖惩情况', group: '补充声明', inputType: 'textarea', sensitive: false, autoFill: true, patterns: ['奖惩情况', '奖惩', '奖励与处分', '受奖惩情况', 're:reward|punish|discipline'] },
    { key: 'medicalHistory', label: '体检史/病史', group: '补充声明', inputType: 'textarea', sensitive: true, autoFill: true, patterns: ['体检史', '病史', '健康状况说明', '体检情况', 're:medical.?history|illness|disease'] },
  ];

  const SOE_LONG_TEMPLATE = SHORT_FORM_TEMPLATE.concat(SOE_EXTRA_TEMPLATE);

  // 模板元信息：2026-09-06 起合并为单一全字段模板（用户要求不再分长短表单）
  const TEMPLATES = [
    { id: 'all', name: '全字段（互联网+央国企）', fields: SOE_LONG_TEMPLATE },
  ];

  // 旧模板 id → 全字段（兼容老数据，makeProfile('x','short') 也能拿到全字段）
  const LEGACY_TEMPLATE_IDS = new Set(['short', 'soe']);

  // key -> 字段定义（含扩展同义词组；扩展组不出现在任何模板里）
  const FIELD_INDEX = {};
  for (const f of SOE_LONG_TEMPLATE) {
    FIELD_INDEX[f.key] = f;
  }
  for (const g of SYNONYMS) {
    if (!FIELD_INDEX[g.key]) {
      FIELD_INDEX[g.key] = {
        key: g.key,
        label: g.key,
        group: '其他',
        inputType: 'text',
        sensitive: !!g.sensitive,
        autoFill: true,
        patterns: g.patterns,
        synonymOnly: true,
      };
    }
  }

  // 对 label 做最佳匹配：返回 { key, score, field } 或 null（material 字段不参与表单匹配）
  function matchLabel(rawLabel) {
    const norm = normalizeLabel(rawLabel);
    if (!norm || norm.length > 30) return null; // 过长文本（题干等）不参与匹配
    let best = null;
    for (const g of SYNONYMS) {
      if (g.material) continue;
      const s = scoreGroup(norm, g.patterns);
      if (s > 0 && (!best || s > best.score)) {
        best = { key: g.key, score: s, field: FIELD_INDEX[g.key] };
      }
    }
    return best;
  }

  // 由模板生成档案（background 与各页面共用）
  function makeId(prefix) {
    return (prefix || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function makeProfile(name, templateId, id) {
    const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
    return {
      id: id || makeId('p'),
      name,
      createdAt: Date.now(),
      templateId: tpl.id,
      fields: tpl.fields.map((f) => ({
        fid: 'f_' + f.key,
        key: f.key,
        label: f.label,
        value: '',
        group: f.group,
        inputType: f.inputType,
        options: f.options ? f.options.slice() : undefined,
        sensitive: !!f.sensitive,
        autoFill: f.autoFill !== false && !f.material,
        material: !!f.material,
        custom: false,
      })),
      materials: [],
    };
  }

  // 老档案升级：补齐全字段模板缺失的字段、统一 autoFill 策略（非素材字段都可自动填）。
  // 幂等，可重复调用；__wsaFull 标记升级完成。
  function upgradeProfile(profile) {
    if (!profile || profile.__wsaFull) return profile;
    const byKey = new Map(profile.fields.map((f) => [f.key, f]));
    for (const tf of SOE_LONG_TEMPLATE) {
      const cur = byKey.get(tf.key);
      if (cur) {
        if (!cur.material) cur.autoFill = true; // 新策略：有值就自动填
        continue;
      }
      const nf = {
        fid: 'f_' + tf.key,
        key: tf.key,
        label: tf.label,
        value: '',
        group: tf.group,
        inputType: tf.inputType,
        options: tf.options ? tf.options.slice() : undefined,
        sensitive: !!tf.sensitive,
        autoFill: tf.autoFill !== false && !tf.material,
        material: !!tf.material,
        custom: false,
      };
      profile.fields.push(nf);
      byKey.set(tf.key, nf);
    }
    profile.templateId = 'all';
    profile.__wsaFull = true;
    return profile;
  }

  // 默认存储状态（background 与各页面共用，保证任何一方先启动都能自愈种子）
  function defaultState() {
    const p1 = makeProfile('我的档案', 'all', 'p1');
    return {
      schemaVersion: 1,
      migratedFullFields: true,
      settings: {
        apiKey: '',
        model: 'glm-5.3-flash',
        autoThreshold: 0.85,
        privacyMask: true,
        autoFloatbar: true,
        provider: 'zhipu',
      },
      activeProfileId: p1.id,
      profiles: [p1],
      ledger: [],
      drafts: {},
    };
  }

  global.WangshenTemplates = {
    SYNONYMS,
    TEMPLATES,
    SHORT_FORM_TEMPLATE,
    SOE_LONG_TEMPLATE,
    FIELD_INDEX,
    normalizeLabel,
    matchLabel,
    makeId,
    makeProfile,
    upgradeProfile,
    defaultState,
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
