/**
 * 🔥 TeeGal 使用指南知识库
 * 包含平台功能、工具使用、扩展工具创建等 Q&A
 */

export interface KnowledgeItem {
  /** 问题 */
  question: string;
  /** 答案 */
  answer: string;
  /** 关键词（用于检索匹配） */
  keywords: string[];
  /** 分类 */
  category: 'training' | 'data' | 'model' | 'platform' | 'pricing' | 'security';
}

/**
 * 使用指南知识库
 */
export const useGuideKnowledgeBase: KnowledgeItem[] = [
  {
    question: "你能做什么？",
    answer: `AI研究训练平台，可操作本地电脑、编写文件、生图视频，核心能力是根据业务自动研究并构建神经网络，自动生成数学公式，支持数据标注、模型训练、效果评估全流程。`,
    keywords: ["功能", "能力", "做什么", "介绍", "TeeGal", "用途", "能干啥", "有什么功能"],
    category: "platform"
  },
  {
    question: "我要训练一个模型，怎么做？",
    answer: `1) 准备数据：用公开数据集或上传自有数据，让LLM解析结构
2) 创建模型：让LLM根据任务类型自动生成神经网络结构
3) 配置训练：调整学习率、批量大小等参数开始训练
4) 评估效果：在codeedit页面查看loss、准确率等指标和模型可视化`,
    keywords: ["训练", "模型", "怎么做", "步骤", "流程", "开始", "入门", "新手", "如何训练", "训练流程"],
    category: "training"
  },
  {
    question: "模型训练怎么开始？",
    answer: `点击右下角"创建空白项目"→@该项目向LLM提需求。建议先从数据整理开始，或直接向LLM描述需求，他会自动生成代码和神经网络结构。关键是梳理好业务逻辑。`,
    keywords: ["开始", "训练", "启动", "入门", "新手", "怎么开始", "如何开始", "第一步", "初始化"],
    category: "training"
  },
  {
    question: "模型训练的方案怎么做？",
    answer: `神经网络通过随机梯度下降拟合函数，训练方案核心是设计"如何学习"——确定损失函数、优化器、学习率策略，再反推网络架构设计。`,
    keywords: ["方案", "策略", "设计", "神经网络", "学习", "训练方案", "怎么设计", "如何设计"],
    category: "training"
  },
  {
    question: "你有什么优势？",
    answer: `1) 自动研究训练 2) 自主配置资源 3) 神经网络替代代码 4) 可视化降低门槛 5) Agent自动操作`,
    keywords: ["优势", "特点", "好处", "为什么", "亮点", "特色", "竞争力"],
    category: "platform"
  },
  {
    question: "训练价格是怎么定的？",
    answer: `按弹性算力网络报价自动计费，训练前会弹出报价窗口。当前不支持超10亿参数的大模型训练。`,
    keywords: ["价格", "费用", "多少钱", "定价", "收费", "成本", "怎么收费", "贵不贵"],
    category: "pricing"
  },
  {
    question: "我是不是要花很多费用来做训练？",
    answer: `不需要。建议先小批量试训观察收敛方向，确认有效后再扩大规模。有用户训练股票模型仅花费几千元。`,
    keywords: ["费用", "成本", "贵", "便宜", "省钱", "花费", "预算", "省钱"],
    category: "pricing"
  },
  {
    question: "需要什么硬件配置？",
    answer: `使用云端弹性算力，无需本地硬件。接入云服务器自动分配GPU资源。`,
    keywords: ["硬件", "配置", "电脑", "服务器", "GPU", "要求", "需要什么配置", "电脑要求"],
    category: "platform"
  },
  {
    question: "支持哪些模型框架？",
    answer: `仅支持 PyTorch（镜像预装 torch/torchvision cu121 + numpy<2），内置YOLO、ResNet、BERT等模板，也可导入自定义模型。镜像已预装：ultralytics(YOLO目标检测，权重在 /app/weights/)、transformers/accelerate/datasets/diffusers/peft(LLM微调与图像生成)、sklearn/pandas/matplotlib(传统ML)、gymnasium/stable-baselines3/tianshou(强化学习)、torch_geometric(GNN)。阿里云训练环境是封闭网络，代码只能用预装库，数据和模型文件从用户数据目录读取，不要生成联网下载逻辑。

⚠️ TensorFlow 未预装：GPU 镜像里 import tensorflow 会报 ModuleNotFoundError。用户要求 TF 代码时，一律改写为 PyTorch 实现（阿里云环境封闭网络，pip 不可用）。`,
    keywords: ["框架", "PyTorch", "YOLO", "ResNet", "BERT", "模型", "支持什么框架", "TensorFlow", "keras", "tf", "强化学习", "RL", "gym", "gymnasium", "stable-baselines", "PPO", "DQN", "JAX"],
    category: "model"
  },
  {
    question: "数据格式有什么要求？",
    answer: `支持CSV/JSON/Parquet，需包含特征列和标签列。支持自动数据增强和预处理。`,
    keywords: ["数据", "格式", "CSV", "JSON", "parquet", "数据要求", "数据格式", "输入格式"],
    category: "data"
  },
  {
    question: "训练需要多长时间？",
    answer: `复杂任务可能几天到几周，建议先1小时小规模调试确认收敛方向，再扩大训练规模。`,
    keywords: ["时间", "多久", "时长", "训练时间", "多长时间", "训练多久"],
    category: "training"
  },
  {
    question: "怎么评估模型效果？",
    answer: `codeedit界面可监控loss、准确率、召回率、F1等指标，支持混淆矩阵、ROC曲线可视化。关键是观察模型是否收敛。`,
    keywords: ["评估", "效果", "指标", "准确率", "loss", "收敛", "怎么看效果", "效果评估"],
    category: "training"
  },
  {
    question: "训练好的模型怎么用？",
    answer: `可导出为pth格式，部署到本地服务、边缘设备或云端服务器。`,
    keywords: ["导出", "部署", "使用", "pth", "模型应用", "怎么用", "发布"],
    category: "model"
  },
  {
    question: "不会编程能用吗？",
    answer: `可以。全程可视化+LLM辅助，无需写代码。高级用户也可自定义脚本兼顾灵活度。`,
    keywords: ["编程", "代码", "零基础", "新手", "门槛", "不会代码", "不会编程"],
    category: "platform"
  },
  {
    question: "数据安全吗？",
    answer: `数据可存本地或云端，弹性算力机器随用随销毁，不保留用户数据。`,
    keywords: ["安全", "隐私", "保护", "数据安全", "泄露", "保密"],
    category: "security"
  },
  {
    question: "工具系统介绍？",
    answer: `工具分类：
• userpc_xxx：操作本地电脑（shell/python/截图等）
• web_xxx：公域资源（搜索/URL读取等）
• 其他工具：平台核心功能（项目/GPU训练/图像/视频/邮件等）

🔥 新版工具名称已简化，无需前缀即可直接使用。`,
    keywords: ["工具系统", "工具介绍", "userpc", "web", "工具分类", "有哪些工具"],
    category: "platform"
  },
  {
    question: "搞错了工具系统？",
    answer: `常见混淆：
• userpc=你的电脑，其他=平台功能

快速判断：操作电脑→userpc_xxx，网络搜索→web_xxx，其他→平台功能`,
    keywords: ["工具错误", "搞错工具", "工具混淆", "userpc", "web", "选错工具"],
    category: "platform"
  },
  {
    question: "你能自动创建新工具吗？",
    answer: `可以！在"扩展工具"项目里创建工具文件，4步完成：

1. projectId 固定为 base-extensiontool，直接在该项目下新增工具即可
2. 用 save_project_file 创建工具代码: projectId=base-extensiontool, filePath=tools/你的工具名.js, content=工具代码
3. 用 save_project_file 更新注册表: projectId=base-extensiontool, filePath=tools/registry.json, content=加入新工具登记
4. 保存 registry.json 后工具立即热加载生效，可直接调用（无需刷新页面）

工具代码格式（.js 纯函数体，不能用 import）：
- 作用域内有 params（参数对象）和 context（执行上下文）
- context 含 userId/conversationId/llm/loadFile
- context.llm.call({ purpose/modelId, messages }) 调用 LLM
- return { success: true, data: {...} } 或 { success: false, error: '...' }

注册表 registry.json 格式：
{ "tools": [{ "name": "工具名", "file": "你的工具名.js", "description": "...", "tokens": ["execution"], "params": "参数名" }] }`,
    keywords: ["创建工具", "自动创建工具", "扩展工具", "基础项目", "新工具", "自定义工具", "创造", "create tool", "tool", "registry.json", "模板", "template"],
    category: "platform"
  },
  {
    question: "如何创建自定义工具？",
    answer: `在"扩展工具"项目里创建，完整步骤：

1. 扩展工具项目的 projectId 固定为 base-extensiontool（无需查询，直接使用）
2. 用 save_project_file 创建工具代码: projectId=base-extensiontool, filePath=tools/你的工具名.js, content=(见下方格式)
3. 用 read_project_file 读取当前 registry.json: projectId=base-extensiontool, filePath=tools/registry.json
4. 用 save_project_file 更新 registry.json，在 tools 数组里加入新工具登记项
5. 保存 registry.json 后工具立即热加载生效，可直接调用新工具

工具 .js 文件格式（纯函数体，不用 import）：
const name = params.name || '世界';
const llmResult = await context.llm.call({ purpose: 'organization.summary', messages: [...] });
return { success: true, data: { result: llmResult.content } };

注册表登记项格式：
{ "name": "工具名", "file": "你的工具名.js", "description": "工具描述", "tokens": ["execution"], "params": "name" }

多文件工具：辅助文件用 context.loadFile('子目录/helper.js') 加载，辅助文件约定 return 出导出内容。`,
    keywords: ["自定义工具", "创建工具步骤", "扩展工具", "基础项目", "工具开发", "怎么创建工具", "registry.json", "模板文件", "注册工具", "工具路径", "loadFile", "多文件工具"],

    category: "platform"
  },
  {
    question: "扩展工具项目是什么？",
    answer: `"扩展工具"是系统级项目（app_type=system_base，projectId 固定为 base-extensiontool），存放 LLM 动态创建的工具。不可删除，只能修改其中的工具文件。

工具文件存在该项目的 tools/ 目录下：
- tools/registry.json：注册表，登记所有工具（只有这里登记的工具才会被加载）
- tools/你的工具名.js：工具执行代码（纯函数体）

用 save_project_file/read_project_file 直接以 projectId=base-extensiontool 操作其中的文件（list_projects 中它排在最前）。`,
    keywords: ["扩展工具", "基础项目", "base-extensiontool", "base project", "system_base", "动态工具", "工具扩展", "自定义工具", "什么是扩展工具", "registry.json"],
    category: "platform"
  },
  {
    question: "工具文件格式是什么？",
    answer: `工具文件是 .js 纯函数体（不用 import/export），作用域内注入两个变量：

1. params：用户传入的参数对象
2. context：执行上下文
   - context.userId / context.conversationId：用户与会话
   - context.llm.call({ purpose/modelId, messages })：调用 LLM
   - context.llm.listModels()：列出可用模型
   - context.loadFile('子目录/helper.js')：加载辅助文件（多文件工具用）

返回值（return）：
- 成功: { success: true, data: {...} }
- 失败: { success: false, error: '错误信息' }

示例（tools/example.js）：
const name = params.name || '世界';
return { success: true, data: { greeting: '你好，' + name } };

注意：不能用 import，依赖的能力只能从 context 取。fetch/electron 等全局可用。`,
    keywords: ["工具格式", "工具模板", "函数体", "execute", "基础工具格式", "怎么写工具", "example.js", "模板", "工具结构", "context", "params", "loadFile"],
    category: "platform"
  },
  {
    question: "扩展工具怎么调用LLM？",
    answer: `通过context.llm调用：
1. 按用途: context.llm.call({ purpose: 'organization.summary', messages: [...] })
2. 按模型: context.llm.call({ modelId: 'custom-xxx', messages: [...] })

内置purpose: organization.summary/plan/execution, assistant.code/image_gen/video_gen/research/vision/speech_recognition
查看可用模型: context.llm.listModels()`,
    keywords: ["LLM", "调用LLM", "context.llm", "llm.call", "模型调用", "purpose", "用途", "角色", "内置模型", "绑定模型", "listModels"],
    category: "platform"
  },
  {
    question: "怎么读取网页内容？",
    answer: `用web_url_reader工具，提供完整URL即可提取网页内容。`,
    keywords: ["读网页", "url", "网页内容", "web_url_reader", "读取链接", "网页"],
    category: "platform"
  },
  {
    question: "怎么搜索网络信息？",
    answer: `用web_search进行网络搜索。`,
    keywords: ["搜索", "网络搜索", "web_search", "查找", "google", "百度", "搜索工具"],
    category: "platform"
  },
  {
    question: "怎么操作本地文件？",
    answer: `操作电脑上的任意文件用 userpc_shell 执行命令（如 cat/type/echo）。操作项目内的文件用 read_project_file/save_project_file/list_project_files/delete_project_file。`,
    keywords: ["本地文件", "文件操作", "操作电脑", "userpc", "文件管理", "本地操作"],
    category: "platform"
  },
  {
    question: "怎么运行Python代码？",
    answer: `用userpc_run_python工具，直接提供Python代码即可在本地执行。`,
    keywords: ["python", "运行python", "执行代码", "userpc_run_python", "py", "脚本"],
    category: "platform"
  },
  {
    question: "怎么执行shell命令？",
    answer: `用userpc_shell工具，提供命令即可在本地终端执行。`,
    keywords: ["shell", "命令行", "终端", "cmd", "bash", "userpc_shell", "执行命令"],
    category: "platform"
  },
  {
    question: "怎么查看账户余额？",
    answer: `用get_account_info工具查询账户信息和积分余额（一次调用返回邮箱、昵称、余额、预估可调用次数等）。`,
    keywords: ["余额", "账户", "多少钱", "get_account_info", "teegal_get_account_info", "查询余额", "账户信息", "check_user_credits", "积分"],
    category: "platform"
  },
  {
    question: "怎么创建项目？",
    answer: `点击右上角"创建空白项目"，或向 LLM 描述需求让他自动生成代码。
也可以用 upsert_project 工具：upsert_project(name='项目名称', description='描述')。
带 projectId 则为更新元信息：upsert_project(projectId='xxx', description='新的项目自述')——请随手维护 description，这是跨会话理解项目的唯一线索。`,
    keywords: ["创建项目", "新建项目", "创建训练项目", "新建训练项目", "train_project", "项目", "怎么创建"],
    category: "platform"
  },
  {
    question: "项目和本地文件有什么区别？",
    answer: `项目是 Teegal 平台的核心单元，支持：
- GPU 训练项目：深度学习训练/推理，用 run_project_oncloud 启动云端 GPU 执行
- CPU 项目：数据处理、Web 开发等，用 run_project_onlocal 本地执行
- 代码分享和协作
- 小文件存储
- 后端执行沙箱（CPU/GPU）

本地 .py 文件可通过 run_project_oncloud 传入路径直接启动训练，自动创建项目并享受平台服务。`,
    keywords: ["项目", "训练项目", "本地文件", "区别", "train_project", "pcfile", "平台服务", "项目类型"],
    category: "platform"
  },
  {
    question: "怎么运行项目？",
    answer: `有两种方式：

1. GPU训练（推荐用于深度学习）
用 run_project_oncloud 工具，需指定 gpuInstanceType。

🔥 先用 list_instance_types 工具查询可用规格和价格，再选择合适的 GPU。

示例流程：
{
  "name": "list_instance_types",  // 🔥 先查询可用规格
  "parameters": {}
}
// 根据返回选择合适的规格，如 ecs.gn6i-c4g1.xlarge（最便宜）
{
  "name": "run_project_oncloud",
  "parameters": {
    "projectId": "项目ID（32位）",
    "gpuInstanceType": "ecs.gn6i-c4g1.xlarge"  // 从 list_instance_types 返回中选择
  }
}

注意：
- gpuInstanceType 格式决定云服务商：ecs.* → 阿里云，GN* → 腾讯云
- 不要手动列举规格，用 list_instance_types 获取最新信息
- ⚠️ 与用户沟通时，不要提及云厂商和实例编码(instanceType)，只说GPU类型(如T4/A10)和价格即可，避免暴露GPU来源

2. CPU执行
- 前端点击"运行"按钮
- 用 userpc_run_python / run_project_onlocal 工具执行本地脚本

🔥 重要提示：本地执行仅适合轻量级 Python 脚本、数据处理、Web 开发等 CPU 任务。
如果代码包含 torch、cuda、transformers 等深度学习组件，强烈建议使用 GPU 训练（run_project_oncloud），原因：
- 本地通常没有 GPU 和 CUDA 环境，代码会因缺少依赖而报错
- 即使安装了 PyTorch CPU 版，训练速度极慢（可能比 GPU 慢 10-100 倍）
- 长时间运行会占用本地资源，影响其他工作

⚠️ 框架限制：GPU 镜像仅预装 PyTorch，TensorFlow 未预装。遇到 TF/keras 代码，先用 PyTorch 改写再送 GPU 训练；直接送 TF 代码会因缺少依赖失败。`,
    keywords: ["运行项目", "启动项目", "训练", "run_project_oncloud", "userpc_run_python", "执行项目", "运行模型", "开始训练", "GPU规格", "GPU类型", "list_instance_types", "run_project_onlocal"],
    category: "platform"
  },
  {
    question: "怎么开一台云端 SSH 实例直接操作？",
    answer: `用 ssh_instance 工具，三步编排：开机 → userpc_shell 免密 ssh 操作 → 关机结算。

1. 开机：ssh_instance(action='activate', instanceType='S5.MEDIUM4')
   - instanceType 用 list_instance_types 查到的 CPU 通用计算规格（S5.*）
   - 开机时自动注入本地 SSH 公钥，就绪后返回实例 IP、凭据名、单价
   - 若已有同规格活跃实例会直接复用，不会重复开机计费

2. 操作：用 userpc_shell 直接 ssh（公钥免密，无需密码）
   Windows: userpc_shell(command="ssh -i \"$env:USERPROFILE\\.ssh\\id_ed25519\" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no ubuntu@<IP> '命令'")
   macOS/Linux: userpc_shell(command="ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no ubuntu@<IP> '命令'")
   - ⚠️ 登录用户是 ubuntu（Ubuntu 镜像禁 root SSH）；需要 root 权限用 'sudo 命令' 或 'sudo -i'
   - ⚠️ 必须带 -o BatchMode=yes：认证失败立即报错退出；不带会在等密码输入时挂死
   - ⚠️ Windows 须带 -i 指定私钥（-NoProfile 环境下 ssh 可能找不到默认密钥）
   - 兜底：若公钥探测失败（Permission denied），用 plink 密码通道（activate 输出会给出 authMode=password 和 hostkey 指纹，命令模板原样照抄）：
     userpc_shell(command="& \"$env:USERPROFILE\\.teegal\\bin\\plink.exe\" -ssh -batch -hostkey \"<activate返回的指纹>\" -pw $env:SSHPASS ubuntu@<IP> \"命令\"", credentialName=<activate 返回的凭据名>)
   - 实例就是一台干净 Linux 机器：可装依赖、git clone、跑服务、传文件
   - 多条命令依次执行即可，机器在两次命令之间保持运行状态

3. 关机：ssh_instance(action='close', instanceId='<实例ID>')
   - 云端按开机→关机时长自动结算扣费，关机即停止计费
   - ssh_instance(action='list') 随时查看活跃实例

4. 自有服务器（用户自己的机器，不租云端）：ssh_instance(action='add', host='<IP>', username='<用户名>', password='<密码>')，port 默认 22
   - 不计费、不经过云端账本；绑定前自动做连通测试并配公钥免密
   - list 中显示为"自有机器（不计费）"；close 只解除与项目的绑定，机器本身不受影响

⚠️ 注意：
- 与 run_project_oncloud（跑完即销毁）不同，SSH 实例从开机到关机持续计费，用完务必 close
- 超过最长租期或余额不足时云端会自动关机`,
    keywords: ["ssh", "ssh_instance", "云主机", "开机", "远程机器", "云服务器", "租用实例", "linux实例", "S5", "CPU实例", "远程操作", "远程开发", "自有机器", "自有服务器", "绑定服务器"],
    category: "platform"
  },
  {
    question: "怎么查看项目代码？",
    answer: `用 read_project_file 工具，提供项目ID和文件路径即可读取代码内容。

支持所有类型的项目（GPU 训练项目、Python 项目、Web 项目等）。
如果是单文件项目，filePath 通常为 'main.py'。
如果是多文件项目，先用 list_project_files 查看文件树，再读取具体文件。`,
    keywords: ["查看代码", "获取代码", "read_project_file", "get_train_project_code", "teegal_get_train_project_code", "代码", "项目代码", "读取项目文件"],
    category: "platform"
  },
  {
    question: "怎么保存项目代码？",
    answer: `工作流程：
1. read_project_file 获取现有代码
2. 你自己修改代码
3. 选择保存方式：
   - edit_project_file：局部编辑，只传修改的部分（推荐，省token）
   - save_project_file：保存完整文件内容（适合创建新文件或大范围重写）

edit_project_file 用法（推荐）：
  edit_project_file(projectId='xxx', filePath='main.py', edits=[
    {oldText: 'lr=0.001', newText: 'lr=0.0001'},
    {oldText: 'epochs=10', newText: 'epochs=50'}
  ])
先 read_project_file 读取代码，然后精确复制要修改的代码片段作为 oldText，写好 newText，不需要传整个文件。

save_project_file 只用于保存代码，不生成代码。必须提供完整的 content 参数。
支持所有类型的项目（GPU 训练项目、Python 项目、Web 项目等）。`,
    keywords: ["编辑代码", "修改代码", "edit_project_file", "save_project_file", "save_train_project_code", "edit_train_project_code", "teegal_save_train_project", "teegal_codeedit", "更新项目", "保存项目", "保存代码", "局部编辑", "search replace"],
    category: "platform"
  },
  {
    question: "怎么训练模型？",
    answer: `用run_project_oncloud工具启动GPU训练。

必须传入gpuInstanceType参数。

阿里云规格（ecs.*格式）：
- ecs.gn6i-c4g1.xlarge (T4 1卡4核16G，¥15.0/小时，最便宜)
- ecs.gn6i-c8g1.2xlarge (T4 1卡8核32G，¥18.0/小时)
- ecs.gn6i-c16g1.4xlarge (T4 2卡16核64G，¥21.0/小时)
- ecs.gn7i-c8g1.2xlarge (A10 1卡8核32G，¥19.0/小时)
- ecs.gn7i-c16g1.4xlarge (A10 2卡16核64G，¥34.0/小时)
- ecs.gn6v-c8g1.2xlarge (V100 1卡8核32G，¥34.0/小时)
- ecs.gn6v-c16g1.4xlarge (V100 2卡16核64G，¥68.0/小时)
- ecs.gn7-c12g1.3xlarge (A100 1卡12核96G，¥46.0/小时)
- ecs.gn8-c16g1.4xlarge (H100 1卡16核128G，¥72.0/小时)

腾讯云规格（GN*格式）：
- GN7.2XLARGE32 (T4 1卡2核32G，¥12.0/小时)
- GN7.5XLARGE80 (T4 2卡5核80G，¥20.0/小时)
- GN10Xp.2XLARGE40 (V100 1卡2核40G，¥21.0/小时)
- GN10Xp.5XLARGE80 (V100 2卡5核80G，¥42.0/小时)
- GT4.4XLARGE96 (A100 1卡4核96G，¥41.0/小时)
- GT4.8XLARGE192 (A100 2卡8核192G，¥82.0/小时)

示例：
{
  "name": "run_project_oncloud",
  "parameters": {
    "projectId": "项目ID",
    "gpuInstanceType": "ecs.gn6i-c4g1.xlarge"
  }
}

也可传入本地文件路径：
{
  "filePath": "C:/project/train.py",
  "gpuInstanceType": "ecs.gn6i-c4g1.xlarge"
}

注意：系统会根据gpuInstanceType格式自动选择云服务商（ecs.*→阿里云，GN*→腾讯云）

⚠️ 与用户沟通时，不要提及云厂商和实例编码(instanceType)，只说GPU类型(如T4/A10/V100)和价格即可，避免暴露GPU来源。`,
    keywords: ["训练", "run_project_oncloud", "开始训练", "模型训练", "train", "GPU训练", "深度学习"],
    category: "training"
  },
  {
    question: "本地执行和GPU训练怎么选择？",
    answer: `根据代码内容选择执行方式：

✅ 适合本地执行（run_project_onlocal）的场景：
- 数据处理、清洗、分析（pandas、numpy）
- Web 开发、API 服务（flask、fastapi、vite）
- 文件操作、脚本自动化
- 轻量级推理或小规模测试

❌ 不适合本地执行，应使用 GPU 训练（run_project_oncloud）：
- import torch / torch.nn / torch.cuda（PyTorch 训练/推理）
- import tensorflow / keras（TensorFlow 训练/推理）
- from transformers import *（HuggingFace 模型）
- model.train() / model.fit() / .cuda() / .to(device) 等训练代码
- 任何包含 CUDA/GPU 相关的代码

原因：
1. 本地通常没有 GPU 和 CUDA，深度学习框架会报错
2. 即使有 PyTorch CPU 版，训练速度比 GPU 慢 10-100 倍
3. 长时间训练会占用本地 CPU 和内存，影响其他工作

🔥 如果用户想在本地测试深度学习代码的逻辑（不训练），可以先建议在代码中加 device='cpu'，用小数据集快速验证逻辑是否正确，确认后再用 run_project_oncloud 启动 GPU 训练。`,
    keywords: ["本地执行", "GPU训练", "CPU执行", "run_project_onlocal", "torch", "cuda", "深度学习", "本地运行", "选择执行方式", "训练还是本地"],
    category: "training"
  },
  {
    question: "怎么查看训练任务历史？",
    answer: `用list_train_tasks工具查看某个项目的所有训练任务列表（含标记和备注），用get_train_task_detail工具查看某个任务的详细信息（包括输出日志、图表等）。
训练完成后建议用update_train_task_remark工具为任务添加备注，记录本次训练的主要修改内容和结果，便于后续迭代时快速了解每次训练的重点。例如：update_train_task_remark(taskId='xxx', remark='本次修改kl离散度loss_weight从0.1到0.3，val_loss从2.3降到1.8')`,
    keywords: ["训练任务", "任务历史", "list_train_tasks", "get_train_task_detail", "训练记录", "任务列表", "任务详情", "update_train_task_remark", "训练备注", "训练总结"],
    category: "platform"
  },
  {
    question: "怎么停止正在进行的GPU训练？",
    answer: `用stop_gpu_train工具停止正在运行的GPU训练任务，需要传入taskId参数。可以先用list_train_tasks获取所有训练任务列表，找到正在运行（running/pending状态）的任务的taskId，然后调用stop_gpu_train(taskId='xxx')停止训练。停止后会释放云端ECI实例，不再产生计费。`,
    keywords: ["停止训练", "stop_gpu_train", "停止GPU训练", "终止训练", "停止计费", "释放实例", "stop training"],
    category: "training"
  },
  {
    question: "怎么创建新项目？",
    answer: `用 upsert_project 工具创建新项目。支持所有类型：
- GPU 训练项目：upsert_project(name='PPO训练对比实验', description='对比不同lr的训练效果')
- Python 项目：upsert_project(name='数据分析脚本', description='股票数据清洗与分析')
- Web 项目：upsert_project(name='个人网站', description='基于 Flask 的个人博客')

创建成功后返回 projectId，然后用 save_project_file(projectId='xxx', filePath='main.py', content='...') 写入代码文件。
项目定位/用途变化时，用 upsert_project(projectId='xxx', description='...') 更新自述，方便后续会话快速理解项目。

🔥 GPU 训练项目用 run_project_oncloud(projectId='xxx', gpuInstanceType='xxx') 启动训练。
🔥 CPU 项目用 run_project_onlocal(projectId='xxx') 本地执行，或在前端点击"运行"按钮。`,
    keywords: ["创建项目", "upsert_project", "create_project", "create_train_project", "新建项目", "创建应用", "对比实验", "新项目", "create project", "新建训练项目", "更新项目"],
    category: "platform"
  },
  {
    question: "怎么列出所有项目？",
    answer: `用 list_projects 工具查看当前所有项目列表。包括 GPU 训练项目、Python 项目、Web 项目等所有类型。`,
    keywords: ["列出项目", "项目列表", "list_projects", "list_train_projects", "teegal_list_train_projects", "所有项目", "查看项目", "列出项目"],
    category: "platform"
  },
  {
    question: "怎么分析文件内容？",
    answer: `用 read_project_file 读取项目内文件，或用 userpc_shell 执行命令读取电脑上的任意文件，然后让 LLM 分析内容。`,
    keywords: ["文件分析", "analyze", "文件摘要", "分析文件"],
    category: "platform"
  },
  {
    question: "怎么读取本地文件？",
    answer: `项目内文件用 read_project_file(projectId, filePath)。电脑上的任意文件用 userpc_shell 执行 cat/type 命令。`,
    keywords: ["读文件", "读取文件", "打开文件", "read_project_file", "userpc_shell"],
    category: "platform"
  },
  {
    question: "数据标注怎么做？",
    answer: `在数据窗口选择数据表，点击标签按钮发送给我，我会帮你自动打标签。`,
    keywords: ["标注", "打标签", "label", "数据标注", "标签", "标记"],
    category: "data"
  },
  {
    question: "收敛是什么意思？",
    answer: `指模型loss不再下降、准确率趋于稳定，说明模型已学到数据规律，可以停止训练或调整学习率。`,
    keywords: ["收敛", "convergence", "loss下降", "什么是收敛", "收敛判断"],
    category: "training"
  },
  {
    question: "学习率是什么？",
    answer: `控制模型参数更新步长的超参，太大导致震荡不收敛，太小收敛慢。常用0.001-0.1，可随训练衰减。`,
    keywords: ["学习率", "learning rate", "lr", "超参数", "学习速率"],
    category: "training"
  },
  {
    question: "批量大小batch size怎么选？",
    answer: `小batch(16-64)泛化好但训练慢，大batch(256+)训练快但需更大学习率。显存允许下尽量大，常用32-128。`,
    keywords: ["batch size", "批量", "batch", "批次大小", "超参数"],
    category: "training"
  },
  {
    question: "什么是过拟合？",
    answer: `模型在训练集表现好但测试集差，说明记住了噪声而非学到规律。解决：增加数据、正则化、dropout、早停。`,
    keywords: ["过拟合", "overfitting", "泛化", "过拟", "防止过拟合"],
    category: "training"
  },
  {
    question: "什么是欠拟合？",
    answer: `模型在训练集和测试集表现都差，说明容量不足没学到规律。解决：增加模型复杂度、减少正则化、增加训练轮数。`,
    keywords: ["欠拟合", "underfitting", "拟合不足", "模型太简单"],
    category: "training"
  },
  {
    question: "怎么导入外部数据？",
    answer: `1) URL直接加载：代码中用requests/pandas读取网络数据
2) 本地数据上传：运行Python/Shell获取数据后，用uploadfiletooss上传得到URL，训练代码直接加载`,
    keywords: ["导入数据", "外部数据", "数据导入", "上传数据", "huggingface", "akshare"],
    category: "data"
  },
  {
    question: "怎么上传本地文件到云端？",
    answer: `用uploadfiletooss工具，传入本地路径返回云端URL。
示例: { "localPath": "C:/data/train.csv" } → { "url": "https://..." }`,
    keywords: ["上传文件", "uploadfiletooss", "本地文件", "云端URL", "OSS", "文件上传"],
    category: "platform"
  },
  {
    question: "支持哪些数据格式？",
    answer: `CSV、JSON、Parquet、Excel、图片文件夹、文本文件等。结构化数据用CSV/JSON，大数据用Parquet。`,
    keywords: ["数据格式", "CSV", "JSON", "Parquet", "Excel", "支持格式", "文件格式"],
    category: "data"
  },
  {
    question: "怎么处理缺失值？",
    answer: `可在数据预处理阶段填充（均值/中位数/众数）或删除。让LLM在构建数据处理项目时自动处理。`,
    keywords: ["缺失值", "缺失数据", "空值", "处理缺失", "数据清洗"],
    category: "data"
  },
  {
    question: "怎么做数据增强？",
    answer: `图像：旋转、翻转、裁剪、变色。文本：同义词替换、回译。让LLM在代码中实现相应增强逻辑。`,
    keywords: ["数据增强", "augmentation", "增强", "数据扩充", "augment"],
    category: "data"
  },
  {
    question: "怎么划分训练集和测试集？",
    answer: `常用8:2或7:3划分，确保分布一致。分类任务需分层抽样，时序数据按时间划分。让LLM在预处理代码中实现。`,
    keywords: ["划分数据集", "训练集", "测试集", "验证集", "split", "数据集划分"],
    category: "data"
  },
  {
    question: "什么是特征工程？",
    answer: `将原始数据转换为更适合模型学习的特征。包括归一化、编码、组合特征、降维等。好的特征比复杂模型更重要。`,
    keywords: ["特征工程", "feature engineering", "特征", "特征提取", "feature"],
    category: "data"
  },
  {
    question: "什么是归一化？",
    answer: `将特征缩放到相同范围（如0-1或均值0方差1），加速收敛并防止大数值特征主导。常用MinMax或Standard归一化。`,
    keywords: ["归一化", "normalization", "标准化", "缩放", "scale", "normalize"],
    category: "data"
  },
  {
    question: "什么是one-hot编码？",
    answer: `将类别变量转换为二进制向量，每个类别对应一个维度。适用于无序类别特征，如颜色、类型等。`,
    keywords: ["one-hot", "编码", "独热编码", "类别编码", "categorical", "编码方式"],
    category: "data"
  },
  {
    question: "怎么保存训练好的模型？",
    answer: `训练完成后自动保存为pth格式，可在模型窗口查看和下载，也可导出部署到其他环境。`,
    keywords: ["保存模型", "导出模型", "pth", "模型文件", "checkpoint"],
    category: "model"
  },
  {
    question: "怎么加载已有模型继续训练？",
    answer: `在创建项目时指定预训练模型路径，或在代码中使用torch.load()加载权重后继续训练。`,
    keywords: ["加载模型", "继续训练", "预训练", "fine-tune", "微调", "迁移学习"],
    category: "model"
  },
  {
    question: "什么是预训练模型？",
    answer: `在大数据集上提前训练好的模型，可作为起点微调特定任务。如BERT(NLP)、ResNet(图像)、YOLO(检测)。`,
    keywords: ["预训练", "pretrained", "预训练模型", "迁移学习", "transfer learning"],
    category: "model"
  },
  {
    question: "什么是微调fine-tuning？",
    answer: `在预训练模型基础上，用特定任务数据继续训练。通常冻结底层只训练顶层，或用较小学习率全层微调。`,
    keywords: ["微调", "fine-tuning", "finetune", "迁移学习", "fine tuning"],
    category: "model"
  },
  {
    question: "怎么选择合适的模型？",
    answer: `图像分类用ResNet/EfficientNet，目标检测用YOLO，NLP用BERT/GPT，时序用LSTM/Transformer。让LLM根据任务推荐。`,
    keywords: ["选择模型", "模型选择", "用什么模型", "推荐模型", "模型对比"],
    category: "model"
  },
  {
    question: "什么是CNN？",
    answer: `卷积神经网络，擅长处理图像数据。通过卷积核提取局部特征，池化降维，适合图像分类、检测等任务。`,
    keywords: ["CNN", "卷积", "卷积神经网络", "图像模型", "计算机视觉", "CV"],
    category: "model"
  },
  {
    question: "什么是RNN/LSTM？",
    answer: `循环神经网络，擅长处理序列数据。LSTM是其改进版，解决长序列梯度消失问题，适合文本、时序预测。`,
    keywords: ["RNN", "LSTM", "循环神经网络", "序列模型", "时序", "文本模型"],
    category: "model"
  },
  {
    question: "什么是Transformer？",
    answer: `基于自注意力机制的模型，并行处理序列，擅长捕捉长距离依赖。BERT、GPT、T5都基于此架构。`,
    keywords: ["Transformer", "注意力", "attention", "自注意力", "BERT", "GPT"],
    category: "model"
  },
  {
    question: "什么是YOLO？",
    answer: `You Only Look Once，单阶段目标检测算法，速度快精度高。实时检测首选，支持v3/v5/v8等版本。`,
    keywords: ["YOLO", "目标检测", "object detection", "检测模型", "yolov8"],
    category: "model"
  },
  {
    question: "什么是ResNet？",
    answer: `残差网络，通过跳跃连接解决深层网络梯度消失问题，可训练152+层。图像分类经典骨干网络。`,
    keywords: ["ResNet", "残差网络", "图像分类", "backbone", "分类模型"],
    category: "model"
  },
  {
    question: "什么是BERT？",
    answer: `双向编码器表示，NLP预训练模型。理解上下文语义，适合分类、NER、问答等任务。`,
    keywords: ["BERT", "NLP", "自然语言", "文本模型", "预训练", "语言模型"],
    category: "model"
  },
  {
    question: "什么是GPT？",
    answer: `生成式预训练Transformer，自回归语言模型。擅长文本生成、续写、对话，GPT-3/4即基于此。`,
    keywords: ["GPT", "生成模型", "语言模型", "文本生成", "GPT-3", "GPT-4"],
    category: "model"
  },
  {
    question: "什么是自注意力机制？",
    answer: `计算序列中每个位置与其他位置的相关性权重，让模型关注重要信息。Transformer核心，可并行计算。`,
    keywords: ["注意力", "attention", "自注意力", "self-attention", "机制"],
    category: "model"
  },
  {
    question: "什么是dropout？",
    answer: `训练时随机丢弃部分神经元，防止过拟合。常用比率0.2-0.5。测试时恢复完整网络。`,
    keywords: ["dropout", "正则化", "防止过拟合", "drop out", "丢弃"],
    category: "training"
  },
  {
    question: "什么是batch normalization？",
    answer: `批归一化，对每个batch的数据归一化，加速训练、允许更大学习率、有轻微正则化效果。`,
    keywords: ["batch norm", "批归一化", "BN", "normalization", "批量归一化"],
    category: "training"
  },
  {
    question: "什么是早停early stopping？",
    answer: `验证集loss不再下降时停止训练，防止过拟合。保存验证集表现最好的模型。`,
    keywords: ["早停", "early stopping", "early stop", "停止训练", "最佳模型"],
    category: "training"
  },
  {
    question: "什么是学习率衰减？",
    answer: `训练过程中逐渐降低学习率，初期快速收敛，后期精细调整。常用Step、Cosine衰减策略。`,
    keywords: ["学习率衰减", "lr decay", "学习率调整", "scheduler", "学习率策略"],
    category: "training"
  },
  {
    question: "什么是梯度裁剪？",
    answer: `限制梯度最大值，防止梯度爆炸。RNN训练常用，设置阈值如1.0或5.0。`,
    keywords: ["梯度裁剪", "gradient clipping", "梯度爆炸", "clipping", "梯度截断"],
    category: "training"
  },
  {
    question: "什么是交叉熵损失？",
    answer: `分类任务常用损失函数，衡量预测概率分布与真实标签的差异。分类问题首选。`,
    keywords: ["交叉熵", "cross entropy", "损失函数", "loss", "分类损失"],
    category: "training"
  },
  {
    question: "什么是MSE损失？",
    answer: `均方误差，回归任务常用损失函数。计算预测值与真实值差的平方均值。`,
    keywords: ["MSE", "均方误差", "回归损失", "mean squared error", "损失函数"],
    category: "training"
  },
  {
    question: "什么是Adam优化器？",
    answer: `自适应矩估计，结合Momentum和RMSProp优点，自动调整学习率。最常用的优化器，默认推荐。`,
    keywords: ["Adam", "优化器", "optimizer", "AdamW", "SGD", "优化算法"],
    category: "training"
  },
  {
    question: "什么是准确率accuracy？",
    answer: `分类正确样本占总样本比例。适用于类别均衡数据，不均衡时参考F1-score。`,
    keywords: ["准确率", "accuracy", "acc", "指标", "分类指标"],
    category: "training"
  },
  {
    question: "什么是精确率和召回率？",
    answer: `精确率=预测为正且正确的/预测为正的；召回率=预测为正且正确的/实际为正的。二者权衡用F1-score。`,
    keywords: ["精确率", "召回率", "precision", "recall", "F1", "PR"],
    category: "training"
  },
  {
    question: "什么是F1-score？",
    answer: `精确率和召回率的调和平均，综合考虑二者。类别不均衡时的重要指标。`,
    keywords: ["F1", "F1-score", "F1 score", "调和平均", "分类指标"],
    category: "training"
  },
  {
    question: "什么是ROC曲线和AUC？",
    answer: `ROC：不同阈值下的真正率vs假正率曲线；AUC：曲线下面积，0.5随机1.0完美。评估分类器整体性能。`,
    keywords: ["ROC", "AUC", "ROC曲线", "曲线下面积", "分类评估"],
    category: "training"
  },
  {
    question: "什么是混淆矩阵？",
    answer: `展示预测结果与实际标签对比的表格，对角线为正确预测。可直观看出哪类容易混淆。`,
    keywords: ["混淆矩阵", "confusion matrix", "误差矩阵", "分类结果", "预测结果"],
    category: "training"
  },
  {
    question: "什么是k折交叉验证？",
    answer: `将数据分k份，轮流用k-1份训练1份验证，取平均结果。充分利用数据，评估更稳定。`,
    keywords: ["交叉验证", "k-fold", "cross validation", "验证", "k折"],
    category: "training"
  },
  {
    question: "怎么处理类别不平衡？",
    answer: `1) 采样：过采样少数类或欠采样多数类；2) 加权：给少数类更大损失权重；3) 用F1而非准确率评估。`,
    keywords: ["类别不平衡", "imbalanced", "不平衡数据", "样本不均", "class imbalance"],
    category: "data"
  },
  {
    question: "什么是集成学习？",
    answer: `组合多个模型预测结果，如投票、平均、堆叠。Bagging(随机森林)和Boosting(AdaBoost/XGBoost)是主流方法。`,
    keywords: ["集成学习", "ensemble", "随机森林", "boosting", "bagging", "模型融合"],
    category: "model"
  },
  {
    question: "什么是超参数调优？",
    answer: `寻找最优超参数组合的过程。方法：网格搜索、随机搜索、贝叶斯优化。可用optuna等工具自动调优。`,
    keywords: ["超参数", "调参", "调优", "hyperparameter", "grid search", "参数调优"],
    category: "training"
  },
  {
    question: "什么是神经网络的可解释性？",
    answer: `理解模型决策原因的能力。方法：特征重要性、注意力可视化、Grad-CAM等。深度学习模型常被诟病"黑盒"。`,
    keywords: ["可解释性", "explainability", "interpretability", "黑盒", "模型解释"],
    category: "model"
  },
  {
    question: "什么是模型蒸馏？",
    answer: `用大模型(教师)教小模型(学生)，让小模型达到接近大模型的效果但推理更快。模型压缩技术之一。`,
    keywords: ["蒸馏", "knowledge distillation", "模型压缩", "教师学生模型", "distillation"],
    category: "model"
  },
  {
    question: "什么是量化quantization？",
    answer: `将模型参数从float32转为int8等低精度，减少模型大小和推理时间。边缘部署常用技术。`,
    keywords: ["量化", "quantization", "模型量化", "int8", "模型压缩", "边缘部署"],
    category: "model"
  },
  {
    question: "什么是剪枝pruning？",
    answer: `删除不重要的神经元或连接，减小模型大小。可结构化(删通道)或非结构化(稀疏化)。`,
    keywords: ["剪枝", "pruning", "模型剪枝", "稀疏化", "模型压缩"],
    category: "model"
  },
  {
    question: "怎么部署模型到生产环境？",
    answer: `导出为ONNX/TensorRT格式，用Flask/FastAPI封装REST API，或部署到AWS/阿里云等云平台。`,
    keywords: ["部署", "生产环境", "上线", "serving", "模型服务", "API"],
    category: "model"
  },
  {
    question: "什么是边缘计算？",
    answer: `在设备端(手机、IoT)直接运行模型，无需联网。需模型轻量化(量化/剪枝)以适配设备算力。`,
    keywords: ["边缘计算", "edge computing", "端侧", "移动端", "IoT", "设备端"],
    category: "model"
  },
  {
    question: "什么是A/B测试？",
    answer: `对比两个模型版本在实际场景的表现，用统计方法确定哪个更好。线上模型迭代的金标准。`,
    keywords: ["A/B测试", "AB test", "对比测试", "线上实验", "模型对比"],
    category: "platform"
  },
  {
    question: "什么是数据泄露？",
    answer: `测试集信息间接出现在训练集中，导致评估结果虚高。常见错误：预处理时用全量数据统计。`,
    keywords: ["数据泄露", "data leakage", "泄露", "评估虚高", "预处理"],
    category: "data"
  },
  {
    question: "什么是特征泄露？",
    answer: `用未来信息预测过去，如用"下单时间"预测"是否购买"。导致模型上线后失效。`,
    keywords: ["特征泄露", "feature leakage", "未来信息", "因果倒置", "时序泄露"],
    category: "data"
  },
  {
    question: "怎么处理文本数据？",
    answer: `1) 分词；2) 去停用词；3) 向量化(词嵌入/TF-IDF)；4) 截断/填充到固定长度。让LLM在代码中实现。`,
    keywords: ["文本处理", "NLP预处理", "分词", "向量化", "文本清洗", "自然语言处理"],
    category: "data"
  },
  {
    question: "怎么处理图像数据？",
    answer: `1) Resize到统一尺寸；2) 归一化；3) 数据增强；4) 转Tensor。CNN通常输入224x224或640x640。`,
    keywords: ["图像处理", "图片预处理", "resize", "图像增强", "CV预处理"],
    category: "data"
  },
  {
    question: "什么是迁移学习？",
    answer: `将在一个任务学到的知识应用到相关任务。常用预训练模型+微调，节省数据和时间。`,
    keywords: ["迁移学习", "transfer learning", "domain adaptation", "跨域", "知识迁移"],
    category: "model"
  },
  {
    question: "什么是多任务学习？",
    answer: `一个模型同时学习多个相关任务，共享底层表示。如同时做检测和分类，相互促进提升效果。`,
    keywords: ["多任务", "multi-task", "多目标", "共享表示", "联合训练"],
    category: "model"
  },
  {
    question: "什么是对抗训练？",
    answer: `在训练时加入对抗样本，提升模型鲁棒性。FGSM、PGD是常用方法，防御对抗攻击。`,
    keywords: ["对抗训练", "adversarial training", "对抗样本", "鲁棒性", "adversarial"],
    category: "training"
  },
  {
    question: "什么是元学习？",
    answer: `"学会学习"，让模型快速适应新任务。Few-shot场景用，如MAML、Prototypical Networks。`,
    keywords: ["元学习", "meta learning", "学会学习", "few-shot", "快速适应"],
    category: "model"
  },
  {
    question: "什么是强化学习？",
    answer: `智能体通过与环境交互学习最优策略，以最大化累积奖励。AlphaGo、自动驾驶、推荐系统都用此技术。`,
    keywords: ["强化学习", "reinforcement learning", "RL", "智能体", "reward", "策略"],
    category: "model"
  },
  {
    question: "什么是生成对抗网络GAN？",
    answer: `生成器与判别器对抗训练，生成逼真数据。用于图像生成、风格迁移、超分辨率等。`,
    keywords: ["GAN", "生成对抗网络", "生成器", "判别器", "对抗生成", "图像生成"],
    category: "model"
  },
  {
    question: "什么是变分自编码器VAE？",
    answer: `学习数据潜在分布的生成模型，可生成新样本、做异常检测、学习解耦表示。`,
    keywords: ["VAE", "变分自编码器", "自编码器", "生成模型", "潜在空间", "latent"],
    category: "model"
  },
  {
    question: "什么是图神经网络GNN？",
    answer: `处理图结构数据的神经网络，聚合邻居信息更新节点表示。用于社交网络、分子结构、推荐系统等。`,
    keywords: ["GNN", "图神经网络", "graph neural network", "图卷积", "GCN", "图数据"],
    category: "model"
  },
  {
    question: "什么是时间序列预测？",
    answer: `根据历史数据预测未来值。常用ARIMA、Prophet、LSTM、Transformer。注意时序泄露问题。`,
    keywords: ["时间序列", "时序预测", "time series", "forecasting", "预测", "时间预测"],
    category: "model"
  },
  {
    question: "什么是异常检测？",
    answer: `识别与正常模式偏离的数据点。可用孤立森林、Autoencoder、One-class SVM等方法。`,
    keywords: ["异常检测", "anomaly detection", "outlier", "异常值", "离群点"],
    category: "model"
  },
  {
    question: "什么是推荐系统？",
    answer: `根据用户历史行为推荐感兴趣的内容。协同过滤、矩阵分解、深度学习方法(如Wide&Deep)。`,
    keywords: ["推荐系统", "recommendation", "协同过滤", "推荐算法", "个性化推荐"],
    category: "model"
  },
  {
    question: "什么是计算机视觉CV？",
    answer: `让机器"看懂"图像视频的技术领域，包括分类、检测、分割、OCR、人脸识别等任务。`,
    keywords: ["计算机视觉", "CV", "computer vision", "图像识别", "视觉AI"],
    category: "model"
  },
  {
    question: "什么是自然语言处理NLP？",
    answer: `让机器理解人类语言的技术领域，包括分类、翻译、摘要、问答、生成等任务。`,
    keywords: ["自然语言处理", "NLP", "natural language processing", "文本处理", "语言AI"],
    category: "model"
  },
  {
    question: "什么是语音识别ASR？",
    answer: `将语音转为文字的技术。深度学习时代用CTC、Attention、Transformer大幅提升准确率。`,
    keywords: ["语音识别", "ASR", "speech recognition", "语音转文字", "语音输入"],
    category: "model"
  },
  {
    question: "什么是语音合成TTS？",
    answer: `将文字转为语音的技术。从拼接合成发展到神经网络声码器(如WaveNet)，越来越自然。`,
    keywords: ["语音合成", "TTS", "text to speech", "文字转语音", "语音输出"],
    category: "model"
  },
  {
    question: "什么是OCR？",
    answer: `光学字符识别，将图片中的文字提取出来。分为文字检测(找位置)和识别(转文字)两步。`,
    keywords: ["OCR", "文字识别", "光学字符识别", "图像转文字", "文字提取"],
    category: "model"
  },
  {
    question: "什么是目标跟踪？",
    answer: `在视频中持续定位特定目标。单目标跟踪(SOT)和多目标跟踪(MOT)，用于监控、自动驾驶等。`,
    keywords: ["目标跟踪", "tracking", "object tracking", "视频跟踪", "MOT", "SOT"],
    category: "model"
  },
  {
    question: "什么是语义分割？",
    answer: `像素级分类，将图像每个像素标上类别。用于自动驾驶(道路/行人)、医学影像等。`,
    keywords: ["语义分割", "semantic segmentation", "分割", "像素级", "图像分割"],
    category: "model"
  },
  {
    question: "什么是实例分割？",
    answer: `区分不同个体的分割，如图中多人分别标出。比语义分割更精细，Mask R-CNN是代表方法。`,
    keywords: ["实例分割", "instance segmentation", "mask rcnn", "个体分割", "目标分割"],
    category: "model"
  },
  {
    question: "什么是姿态估计？",
    answer: `检测人体关键点(关节)位置，估计姿态。用于动作识别、健身APP、人机交互等。`,
    keywords: ["姿态估计", "pose estimation", "关键点检测", "人体姿态", "skeleton"],
    category: "model"
  },
  {
    question: "什么是人脸检测和识别？",
    answer: `检测：找脸位置；识别：确认是谁。MTCNN检测、FaceNet识别是经典方案，注意隐私合规。`,
    keywords: ["人脸检测", "人脸识别", "face detection", "face recognition", "人脸", "facial"],
    category: "model"
  },
  {
    question: "什么是风格迁移？",
    answer: `将一张图的内容与另一张图的风格结合，如照片变油画。Gram矩阵匹配风格特征。`,
    keywords: ["风格迁移", "style transfer", "神经风格", "图像风格", "artistic"],
    category: "model"
  },
  {
    question: "什么是超分辨率？",
    answer: `从低分辨率图像恢复高分辨率细节。SRCNN、SRGAN、ESRGAN是主流方法，用于图像增强。`,
    keywords: ["超分辨率", "super resolution", "图像增强", "放大", "upsampling", "SR"],
    category: "model"
  },
  {
    question: "什么是图像修复inpainting？",
    answer: `填补图像缺失区域，如去除水印、修复老照片。用周围信息或生成模型补全。`,
    keywords: ["图像修复", "inpainting", "填补", "修复", "去水印", "image completion"],
    category: "model"
  },
  {
    question: "什么是图像去噪？",
    answer: `去除图像噪声，恢复清晰图像。传统方法用滤波器，深度学习方法用自编码器或GAN。`,
    keywords: ["图像去噪", "denoising", "降噪", "噪声去除", "image denoising"],
    category: "model"
  },
  {
    question: "什么是图像描述生成？",
    answer: `自动生成图像的文字描述。Encoder-Decoder架构，CNN提取特征，RNN/Transformer生成文本。`,
    keywords: ["图像描述", "image captioning", "看图说话", "图像转文字", "caption"],
    category: "model"
  },
  {
    question: "什么是视觉问答VQA？",
    answer: `根据图像内容回答问题。需理解图像和文本，是多模态学习的典型任务。`,
    keywords: ["视觉问答", "VQA", "visual question answering", "图像问答", "多模态"],
    category: "model"
  },
  {
    question: "什么是对比学习？",
    answer: `学习样本间的相似性关系，让正样本靠近、负样本远离。SimCLR、MoCo是自监督学习代表。`,
    keywords: ["对比学习", "contrastive learning", "自监督", "simclr", "moco", "representation"],
    category: "training"
  },
  {
    question: "什么是自监督学习？",
    answer: `无需人工标注，从数据本身构造监督信号。如预测缺失部分、对比学习，缓解标注成本问题。`,
    keywords: ["自监督", "self-supervised", "无监督", "预训练", "representation learning"],
    category: "training"
  },
  {
    question: "什么是联邦学习？",
    answer: `数据不出本地，只共享模型更新。保护隐私的分布式训练，用于手机输入法等场景。`,
    keywords: ["联邦学习", "federated learning", "隐私保护", "分布式", "联邦"],
    category: "training"
  },
  {
    question: "什么是神经架构搜索NAS？",
    answer: `自动搜索最优网络结构，替代人工设计。用强化学习或进化算法探索架构空间，计算成本高。`,
    keywords: ["NAS", "神经架构搜索", "architecture search", "自动设计", "网络结构搜索"],
    category: "model"
  },
  {
    question: "什么是自动机器学习AutoML？",
    answer: `自动化机器学习全流程，包括特征工程、模型选择、超参调优。降低ML门槛，加速开发。`,
    keywords: ["AutoML", "自动机器学习", "自动化", "auto machine learning", "HPO"],
    category: "platform"
  },
  {
    question: "什么是模型版本管理？",
    answer: `追踪模型迭代过程，记录超参、指标、代码版本。工具如MLflow、DVC，确保实验可复现。`,
    keywords: ["模型版本", "版本管理", "MLflow", "实验管理", "模型追踪", "model registry"],
    category: "platform"
  },
  {
    question: "什么是数据版本管理？",
    answer: `像管理代码一样管理数据，追踪数据变更。DVC是常用工具，确保数据-模型对应关系。`,
    keywords: ["数据版本", "DVC", "数据管理", "版本控制", "data versioning"],
    category: "data"
  },
  {
    question: "什么是特征存储feature store？",
    answer: `统一管理特征的平台，支持在线/离线一致性。避免重复计算，确保训练与推理特征一致。`,
    keywords: ["feature store", "特征存储", "特征平台", "feast", "特征服务"],
    category: "data"
  },
  {
    question: "什么是模型监控？",
    answer: `上线后持续监控模型性能，检测数据漂移、概念漂移。及时发现问题并触发重训练。`,
    keywords: ["模型监控", "model monitoring", "数据漂移", "概念漂移", "线上监控"],
    category: "platform"
  },
  {
    question: "什么是MLOps？",
    answer: `机器学习工程实践，将DevOps理念应用于ML。涵盖数据、模型、部署、监控全生命周期管理。`,
    keywords: ["MLOps", "机器学习工程", "DevOps", "ML工程", "模型运维"],
    category: "platform"
  },
  {
    question: "什么是数据管道data pipeline？",
    answer: `数据从采集到训练的全流程自动化。包括ETL、预处理、特征工程，确保数据新鲜和一致。`,
    keywords: ["数据管道", "data pipeline", "ETL", "数据流", "数据处理流程"],
    category: "data"
  },
  {
    question: "什么是模型服务model serving？",
    answer: `将模型部署为可调用的服务。需考虑延迟、吞吐、扩缩容。工具如TorchServe、TF Serving。`,
    keywords: ["model serving", "模型服务", "模型部署", "推理服务", "serving"],
    category: "model"
  },
  {
    question: "什么是批处理batch inference？",
    answer: `批量处理数据做预测，非实时。适合离线任务，可充分利用资源、提高吞吐。`,
    keywords: ["批处理", "batch inference", "离线推理", "批量预测", "batch"],
    category: "model"
  },
  {
    question: "什么是流处理stream inference？",
    answer: `实时处理数据流做预测，低延迟。用于实时推荐、风控等场景，需流处理框架如Flink。`,
    keywords: ["流处理", "stream inference", "实时推理", "流式预测", "real-time"],
    category: "model"
  },
  {
    question: "什么是模型热更新？",
    answer: `不停机更新模型版本。用蓝绿部署或滚动更新，确保服务连续性，支持快速回滚。`,
    keywords: ["热更新", "hot swap", "模型更新", "不停机更新", "滚动更新"],
    category: "platform"
  },
  {
    question: "什么是金丝雀发布？",
    answer: `先小流量验证新版本，再逐步扩大。降低风险，及时发现问题，是模型上线的最佳实践。`,
    keywords: ["金丝雀", "canary", "灰度发布", "渐进发布", "canary deployment"],
    category: "platform"
  },
  {
    question: "什么是影子模式shadow mode？",
    answer: `新模型并行运行但不影响线上决策，对比与旧模型差异。安全验证新模型效果的方式。`,
    keywords: ["影子模式", "shadow mode", "影子流量", "并行验证", "shadow deployment"],
    category: "platform"
  },
  {
    question: "什么是模型卡片model card？",
    answer: `记录模型信息的文档，包括用途、性能、限制、偏见等。提高模型透明度，负责任AI实践。`,
    keywords: ["模型卡片", "model card", "模型文档", "模型信息", "透明度"],
    category: "platform"
  },
  {
    question: "什么是数据表data sheet？",
    answer: `记录数据集信息的文档，包括来源、收集方式、偏见等。与模型卡片配套，确保数据透明。`,
    keywords: ["数据表", "data sheet", "数据集文档", "数据说明", "数据透明"],
    category: "data"
  },
  {
    question: "什么是负责任AI？",
    answer: `考虑公平性、透明性、隐私保护的AI开发。避免歧视、确保可解释、尊重用户隐私。`,
    keywords: ["负责任AI", "responsible AI", "AI伦理", "公平性", "ethical AI"],
    category: "platform"
  },
  {
    question: "什么是模型偏见？",
    answer: `模型对特定群体不公平，源于训练数据偏见。需检测和缓解，确保公平性。`,
    keywords: ["偏见", "bias", "公平性", "歧视", "模型偏见", "fairness"],
    category: "platform"
  },
  {
    question: "什么是隐私保护机器学习？",
    answer: `在保护数据隐私前提下训练模型。技术包括差分隐私、联邦学习、同态加密等。`,
    keywords: ["隐私保护", "privacy preserving", "差分隐私", "联邦学习", "privacy"],
    category: "security"
  },
  {
    question: "什么是差分隐私？",
    answer: `在数据中加入噪声，保证个体信息不被泄露，同时保持整体统计特性。量化隐私保护强度。`,
    keywords: ["差分隐私", "differential privacy", "隐私", "噪声", "privacy guarantee"],
    category: "security"
  },
  {
    question: "什么是对抗样本攻击？",
    answer: `对输入添加微小扰动导致模型误判。安全关键应用需防范，可用对抗训练提升鲁棒性。`,
    keywords: ["对抗攻击", "adversarial attack", "对抗样本", "攻击", "安全性"],
    category: "security"
  },
  {
    question: "什么是模型窃取攻击？",
    answer: `通过查询API推断模型结构和参数。保护商业机密，可限制查询频率或加水印。`,
    keywords: ["模型窃取", "model stealing", "攻击", "模型安全", "知识产权保护"],
    category: "security"
  },
  {
    question: "什么是数据投毒攻击？",
    answer: `在训练数据中注入恶意样本，使模型行为异常。需数据审核和异常检测防范。`,
    keywords: ["数据投毒", "data poisoning", "攻击", "恶意数据", "训练安全"],
    category: "security"
  },
  {
    question: "怎么开始一个项目？",
    answer: `1) 明确业务目标和评估指标；2) 收集整理数据；3) 让LLM协助设计方案和初始代码；4) 小规模试验验证；5) 迭代优化后扩大训练。`,
    keywords: ["开始项目", "项目启动", "第一步", "怎么做项目", "项目流程"],
    category: "platform"
  },
  {
    question: "怎么评估项目可行性？",
    answer: `检查：1) 数据是否充足且高质量；2) 问题是否适合ML解决；3) 业务指标是否可量化；4) 是否有足够计算资源。`,
    keywords: ["可行性", "项目评估", "能不能做", "可行性分析", "项目判断"],
    category: "platform"
  },
  {
    question: "怎么设计实验？",
    answer: `明确假设、对照组、评估指标。一次只改一个变量，确保结果可解释。记录所有参数和随机种子。`,
    keywords: ["实验设计", "experiment", "对照实验", "ablation", "实验方法"],
    category: "training"
  },
  {
    question: "怎么写实验报告？",
    answer: `包含：问题定义、方法、实验设置、结果、分析、结论。附可复现代码，诚实报告负面结果。`,
    keywords: ["实验报告", "report", "论文", "实验记录", "结果汇报"],
    category: "platform"
  },
  {
    question: "怎么复现论文结果？",
    answer: `找官方代码，严格按论文设置超参和数据。注意随机种子、硬件差异。无法复现时仔细检查细节。`,
    keywords: ["复现", "reproduce", "论文复现", "结果复现", "replication"],
    category: "platform"
  },
  {
    question: "怎么调试模型不收敛？",
    answer: `检查：1) 学习率太大/太小；2) 数据归一化；3) 损失函数；4) 梯度是否消失/爆炸；5) 标签是否正确。`,
    keywords: ["不收敛", "调试", "debug", "loss不降", "训练失败", "troubleshoot"],
    category: "training"
  },
  {
    question: "怎么处理OOM显存不足？",
    answer: `减小batch size、使用梯度累积、降低模型尺寸、使用混合精度训练、清理不必要变量。`,
    keywords: ["OOM", "显存不足", "out of memory", "内存不足", "CUDA out of memory"],
    category: "training"
  },
  {
    question: "怎么加速训练？",
    answer: `使用更大batch size、混合精度、多GPU并行、优化数据加载、使用更高效的模型架构。`,
    keywords: ["加速", "提速", "训练速度", "更快", "性能优化", "speed up"],
    category: "training"
  },
  {
    question: "怎么减少模型大小？",
    answer: `量化、剪枝、知识蒸馏、使用更轻量的架构(如MobileNet)、减少通道数/层数。`,
    keywords: ["模型大小", "轻量化", "压缩", "减小模型", "小模型", "efficient"],
    category: "model"
  },
  {
    question: "怎么提高模型准确率？",
    answer: `增加数据、数据增强、调优超参、换更强的架构、集成多个模型、减少标签错误。`,
    keywords: ["提高准确率", "提升性能", "优化模型", "更好效果", "准确率提升"],
    category: "training"
  },
  {
    question: "怎么处理标签错误？",
    answer: `用置信度学习识别可疑样本，人工复核。或让模型预测训练集，找出预测与标签不一致的样本。`,
    keywords: ["标签错误", "label error", "错误标注", "数据质量", "confident learning"],
    category: "data"
  },
  {
    question: "什么是主动学习？",
    answer: `模型选择最有价值的样本请求人工标注，减少标注量。选择策略如不确定性采样、多样性采样。`,
    keywords: ["主动学习", "active learning", "样本选择", "减少标注", "标注效率"],
    category: "training"
  },
  {
    question: "什么是弱监督学习？",
    answer: `用噪声标签或启发式规则生成伪标签训练。降低标注成本，但需处理标签噪声问题。`,
    keywords: ["弱监督", "weak supervision", "伪标签", "噪声标签", "snorkel"],
    category: "training"
  },
  {
    question: "什么是半监督学习？",
    answer: `同时使用少量标注数据和大量未标注数据。用伪标签或一致性正则化利用未标注数据。`,
    keywords: ["半监督", "semi-supervised", "未标注数据", "伪标签", "consistency"],
    category: "training"
  },
  {
    question: "什么是域适应domain adaptation？",
    answer: `源域训练的模型适应目标域，分布不同但任务相同。方法如对抗训练、自训练。`,
    keywords: ["域适应", "domain adaptation", "迁移", "跨域", "domain shift"],
    category: "training"
  },
  {
    question: "什么是持续学习？",
    answer: `模型持续学习新任务而不遗忘旧知识。解决灾难性遗忘，方法如正则化、回放、动态架构。`,
    keywords: ["持续学习", "continual learning", "终身学习", "灾难性遗忘", "lifelong learning"],
    category: "training"
  },
  {
    question: "什么是多模态学习？",
    answer: `融合多种模态数据(图像+文本+音频)进行学习。CLIP、DALL-E是多模态代表，需对齐不同模态。`,
    keywords: ["多模态", "multimodal", "跨模态", "图像文本", "CLIP", "多模态融合"],
    category: "model"
  },
  {
    question: "什么是指令微调instruction tuning？",
    answer: `用自然语言指令训练模型遵循人类意图。ChatGPT的核心技术，让模型理解并执行各种任务。`,
    keywords: ["指令微调", "instruction tuning", "指令学习", "instruct", "对齐"],
    category: "training"
  },
  {
    question: "什么是RLHF？",
    answer: `基于人类反馈的强化学习，用人类偏好训练奖励模型，再优化策略。ChatGPT的关键技术。`,
    keywords: ["RLHF", "人类反馈", "强化学习", "reward model", "对齐", "alignment"],
    category: "training"
  },
  {
    question: "什么是提示工程prompt engineering？",
    answer: `设计有效的输入提示引导模型输出。包括指令格式、示例选择、思维链等技巧，提升零样本/少样本性能。`,
    keywords: ["提示工程", "prompt engineering", "prompt设计", "提示词", "prompt技巧"],
    category: "platform"
  },
  {
    question: "什么是思维链CoT？",
    answer: `让模型逐步推理展示思考过程，提升复杂任务表现。在提示中加"Let's think step by step"。`,
    keywords: ["思维链", "chain of thought", "CoT", "逐步推理", "step by step"],
    category: "platform"
  },
  {
    question: "什么是少样本学习few-shot？",
    answer: `在提示中给几个示例，让模型学习模式。无需微调，GPT等模型擅长此能力。`,
    keywords: ["少样本", "few-shot", "in-context learning", "示例学习", "上下文学习"],
    category: "platform"
  },
  {
    question: "什么是零样本学习zero-shot？",
    answer: `无需示例直接完成任务，靠预训练知识和指令理解。考验模型泛化能力。`,
    keywords: ["零样本", "zero-shot", "无示例", "直接推理", "泛化能力"],
    category: "platform"
  },
  {
    question: "什么是上下文学习in-context learning？",
    answer: `模型从提示上下文学习新任务，无需参数更新。大模型涌现能力，是prompt engineering基础。`,
    keywords: ["上下文学习", "in-context learning", "上下文", "context learning", "无需训练"],
    category: "platform"
  },
  {
    question: "什么是涌现能力emergent ability？",
    answer: `模型规模达到阈值后突然出现的能力，如推理、上下文学习。小模型没有，大模型突然具备。`,
    keywords: ["涌现", "emergent ability", "scaling law", "能力涌现", "大模型能力"],
    category: "model"
  },
  {
    question: "什么是缩放定律scaling law？",
    answer: `模型性能随规模(参数/数据/计算)幂律增长。指导大模型训练：更大模型需更多数据和计算。`,
    keywords: ["缩放定律", "scaling law", "幂律", "模型规模", "参数增长"],
    category: "model"
  },
  {
    question: "什么是计算最优训练？",
    answer: `给定计算预算，最优分配模型大小和数据量。Chinchilla论文：70B模型需1.4T token。`,
    keywords: ["计算最优", "compute optimal", "chinchilla", "训练效率", "最优配置"],
    category: "training"
  },
  {
    question: "什么是长上下文long context？",
    answer: `处理长序列的能力，如128K token。技术包括位置编码改进、注意力优化。RAG是替代方案。`,
    keywords: ["长上下文", "long context", "长序列", "上下文长度", "long sequence"],
    category: "model"
  },
  {
    question: "什么是RAG检索增强生成？",
    answer: `结合信息检索和文本生成，先从知识库检索相关文档再生成回答。解决知识更新和幻觉问题。`,
    keywords: ["RAG", "检索增强", "retrieval augmented", "知识库", "文档检索"],
    category: "model"
  },
  {
    question: "什么是 DeepSearch？",
    answer: `DeepSearch 是 TeeGal 平台的自动深度搜索功能。它会自动分析用户需求，执行多轮搜索、分析和综合，最终返回完整的研究结果。适合复杂的研究、调研和分析任务。`,
    keywords: ["deepsearch", "深度搜索", "自动搜索", "研究", "调研", "gather", "深度研究"],
    category: "platform"
  },
  {
    question: "怎么使用 DeepSearch？",
    answer: `直接描述你需要深入研究的问题，系统会自动识别并启动 DeepSearch 模式。DeepSearch 会自动规划搜索策略、执行多轮搜索、分析结果并综合输出。你可以在对话中随时提出需要深度研究的问题。`,
    keywords: ["使用deepsearch", "启动搜索", "深度研究", "自动分析", "怎么搜索", "如何使用"],
    category: "platform"
  },
  {
    question: "DeepSearch 和普通的搜索有什么区别？",
    answer: `普通搜索是单次查询返回结果，DeepSearch 是自动多轮搜索：1) 分析问题制定搜索策略；2) 执行多轮搜索收集信息；3) 综合分析和整理结果；4) 如有需要自动深入搜索。适合复杂、需要综合分析的调研任务。`,
    keywords: ["deepsearch区别", "搜索对比", "深度搜索优势", "多轮搜索", "自动调研"],
    category: "platform"
  },
  {
    question: "DeepSearch 能做什么？",
    answer: `DeepSearch 适合：1) 行业调研和市场分析；2) 技术研究和方案对比；3) 竞品分析；4) 学术研究综述；5) 任何需要收集多源信息并综合分析的任务。它会自动搜索、筛选、分析并输出结构化的研究报告。`,
    keywords: ["deepsearch功能", "深度搜索用途", "能做什么", "调研分析", "研究报告"],
    category: "platform"
  },
  {
    question: "GPU训练代码有哪些约束？",
    answer: `GPU训练代码使用以下全局变量（已预定义）：

_OUTPUT_DIR：输出目录（本地磁盘 /tmp/output/）
_files：文件列表（用于前端显示模型文件）
_charts：图表列表（用于前端显示训练图表）

示例代码：
import os, json

# 保存模型（会上传 + 前端显示）
model_path = os.path.join(_OUTPUT_DIR, 'model.pth')
torch.save(model.state_dict(), model_path)
_files.append(model_path)  # 🔥 必须！否则前端不显示

# 保存图表（会上传 + 前端显示）
chart_path = os.path.join(_OUTPUT_DIR, 'loss.png')
plt.savefig(chart_path)
_charts.append(chart_path)  # 🔥 必须！否则前端不显示

# 缓存文件（不上传，放在 /tmp/output 之外）
cache_file = '/tmp/cache/data.pkl'
with open(cache_file, 'wb') as f:
    pickle.dump(df, f)

🔥 结果输出规范（训练结束必须输出）：把整个训练包在 try/finally 中，finally 里单独 print 一行 JSON（无任何前缀文字，系统从日志末尾提取）：
finally:
    print(json.dumps({"success": True, "output": "训练完成 mAP50=0.62", "files": [model_path], "charts": [chart_path]}, ensure_ascii=False))

要求：①单独一行、{ 开头 } 结尾、无 [output] 之类前缀；②必含 success 和 output 字段；③files/charts 写 _OUTPUT_DIR 拼出的绝对路径。
⚠️ 未按规范输出时系统会自动迁移+扫描产物兜底（模型不丢），但结果会带"训练代码未按规范输出结果JSON"的错误标记——建议按规范输出，保证 success/output 状态准确。
⚠️ 上传规则：_OUTPUT_DIR 下所有文件（含子目录）训练后自动上传到云端；但以下判定为缓存/临时文件不上传：以 . 开头的隐藏文件、~ 结尾、.log/.pkl/.cache/.tmp/.pyc 后缀——需要交付的文件不要用这些命名。

⚠️ 网络：云端外网受限，下载数据集请用 list_cloud_files 返回的内网地址；代码里的 OSS/COS 外网 URL 会被系统自动替换为内网，但 GitHub/HuggingFace 等其他外网地址不可用（会卡到超时）。

🔥 训练环境：镜像预装 PyTorch(cu121)/torchvision/numpy<2，其余依赖需在代码开头 pip install（如 transformers、pandas 等，走阿里云镜像源较快）；TensorFlow 未预装，请改用 PyTorch。`,
    keywords: ["GPU训练", "代码约束", "_OUTPUT_DIR", "_files", "_charts", "训练代码", "全局变量", "输出路径", "模型文件", "图表", "前端显示", "保存模型", "保存图表", "预装依赖", "训练环境", "结果JSON", "result.json", "finally输出", "内网下载", "数据集下载"],
    category: "training"
  },
  {
    question: "GPU训练输出文件怎么让前端显示？",
    answer: `两种方式，建议都做：

方式1：append 到全局列表
模型：_files.append(model_path)
图表：_charts.append(chart_path)

方式2：训练结束时（finally 中）单独 print 一行 JSON（无前缀）：
print(json.dumps({"success": True, "output": "摘要", "files": [model_path], "charts": [chart_path]}, ensure_ascii=False))
系统提取该 JSON 作为任务结果，files/charts 中的文件自动上传并回填云端 URL。

路径用 _OUTPUT_DIR 拼绝对路径；写错时系统按文件名兜底匹配。两者都没做时系统自动扫描 /tmp/output 兜底收集（含子目录，如 YOLO runs/ 目录里的 args.yaml、train_batch*.jpg 等框架自动生成产物）。`,
    keywords: ["前端显示", "输出文件", "_files", "_charts", "模型不显示", "图表不显示", "显示模型", "显示图表", "结果JSON", "finally输出"],
    category: "training"
  },
  {
    question: "为什么GPU训练要使用 _OUTPUT_DIR？",
    answer: `GPU训练在云端弹性容器中执行，输出目录统一为 /tmp/output/：
- 阿里云：训练后上传到OSS
- 腾讯云：训练后上传到COS

使用 _OUTPUT_DIR 可以：
1. 自动适配不同云厂商
2. 避免路径硬编码导致的兼容问题

硬编码路径（如 /app/output/）会导致产物不在 /tmp/output 统一收集范围内：系统迁移兜底只覆盖 /root、/home、/tmp 顶层等常见位置，其余自定义路径的产物会直接丢失；且训练容器每次重建，容器内路径不保留，只有 /tmp/output 里的产物会持久化到云端。`,
    keywords: ["全局变量原因", "为什么要用_OUTPUT_DIR", "路径问题", "云厂商差异", "OSS挂载"],
    category: "training"
  },
  {
    question: "凭据是什么？怎么用？",
    answer: `凭据（Credential）是用户预配置的敏感信息（如 SSH 密码、API Key、Token），加密存储在本地，LLM 无法看到明文值。

两种用法：
【用法1：shell 命令引用】
1. 你用 list_credentials 工具查看可用凭据列表（只返回环境变量名和描述，不含明文）
2. 调用 userpc_shell 时传入 credentialName 参数（值为环境变量名）
3. 系统自动将凭据值注入为同名环境变量，命令中可直接用 $SSHPASS 引用

例如：
- 环境变量名: SSHPASS
- userpc_shell(query="sshpass -e ssh user@host", credentialName="SSHPASS")
- 系统自动设置 $SSHPASS 环境变量，sshpass 读取它完成免密登录

【用法2：项目代码引用（自动注入，无需 credentialName）】
在项目代码中直接用环境变量名读取，执行时系统扫描代码发现引用即自动注入：
- Python: os.environ['OPENAI_API_KEY'] 或 os.getenv('OPENAI_API_KEY')
- Node: process.env.OPENAI_API_KEY
- PowerShell: $env:OPENAI_API_KEY
本地执行和 GPU 云端执行都会注入，代码里不需要写明文值。

例如用户凭据列表里有 OPENAI_API_KEY，你写的 Python 代码直接：
client = OpenAI(api_key=os.environ['OPENAI_API_KEY'])
执行时系统自动注入真实值，你全程看不到明文。

⚠️ 你永远看不到凭据的明文值，只能看到环境变量名和描述。`,
    keywords: ["凭据", "credential", "密码", "密钥", "API Key", "token", "敏感信息", "ssh密码", "credentialName", "凭据管理", "安全", "加密", "os.environ", "环境变量注入", "process.env"],
    category: "security"
  },
  {
    question: "怎么查询可用凭据？",
    answer: `用 list_credentials 工具查询当前用户已配置的凭据列表。

返回内容（不含明文值）：
- 环境变量名（env_var）：凭据标识，也是注入时的环境变量名，如 SSHPASS
- 描述（description）：用途说明

示例：
{
  "name": "list_credentials",
  "parameters": {}
}

返回示例：
1. 环境变量名: SSHPASS | 描述: 阿里云SSH密码
2. 环境变量名: OPENAI_API_KEY | 描述: OpenAI API密钥

查到环境变量名后，在 userpc_shell 中用 credentialName 参数引用即可（credentialName 的值就是环境变量名）。`,
    keywords: ["list_credentials", "查询凭据", "凭据列表", "可用凭据", "credential", "凭据名称", "环境变量名"],
    category: "security"
  },
  {
    question: "怎么在命令中使用凭据？",
    answer: `用 userpc_shell 的 credentialName 参数注入凭据为环境变量。

使用方式：
userpc_shell(query="你的命令", credentialName="环境变量名")

系统会自动：
1. 根据环境变量名查找凭据
2. 解密凭据值
3. 注入为同名环境变量
4. 执行命令时该环境变量可用

常见场景：

1. SSH 免密登录（环境变量名 SSHPASS）：
   userpc_shell(query="sshpass -e ssh user@host", credentialName="SSHPASS")

2. 使用 API Key（环境变量名 OPENAI_API_KEY）：
   userpc_shell(query="curl -H \"Authorization: Bearer $OPENAI_API_KEY\" https://api.openai.com/v1/models", credentialName="OPENAI_API_KEY")

3. Python 脚本中读取环境变量：
   先用 userpc_shell 启动脚本并注入凭据，脚本内用 os.environ['API_KEY'] 读取

⚠️ 凭据值不会出现在命令行或日志中（通过 spawn env 注入），安全可靠。`,
    keywords: ["credentialName", "使用凭据", "注入凭据", "环境变量", "sshpass", "API Key", "userpc_shell", "凭据使用", "密码注入"],
    category: "security"
  },
]
