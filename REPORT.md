# zip-codec · REPORT

A-02 ZIP 读写器（PKWARE APPNOTE 本地文件头 + 中央目录模型）。
DEFLATE 引擎移植自 deflate 项目（第二消费方）；oracle：adm-zip 0.6.1、Info-ZIP unzip 6.00、CPython 3.12 zipfile。

## 开工前体检

| 项 | 结论 |
|---|---|
| deflate 项目与 API | 存在；`deflateRaw`/`inflate`/`crc32` 齐备，移植闭包 6 文件（gzip.ts 不需要） |
| adm-zip 0.6.1 | npm 存在 ✓ |
| unzip | Info-ZIP 6.00（git bash）✓ |
| CPython zipfile | 3.12.8（第三方 ZIP64 写入器裁判，任务书外补强）✓ |
| 概念核对 | 本地文件头/中央目录/EOCD/ZIP64/数据描述符/CP437 均为 APPNOTE 标准概念，无跨项目串写 |
| 目录 | `C:\works\zip-codec` 全新，无多会话冲突 |

## 一、实现决策

1. **移植复用**：deflate 6 文件逐字节 diff 验证一致（`tail -n +7 = 原文件`），每文件头部有出处注释；单元测试随迁 16 条（已知 CRC 锚点、9 级往返、zlib 互验、畸形流抛错）。**教训：转写时 diff 抓到过一次 T2/T3 表派生笔误，逐字节 diff 是移植的唯一可信验收**。
2. **文件名编码**：读侧 bit11 → UTF-8，否则 CP437（附录 D）；写侧 ASCII 原样、非 ASCII 一律 UTF-8+EFS。不产出 CP437 编码名。
3. **本地头对齐校验在解析期完成**：readZip 成功 ⇒ 结构可信（签名/名字字节/方法/标志/时间戳逐字段相等；bit3 时 CRC/尺寸允许 0=写时未知）。代价：CD CRC 字段损坏在解析期报 LFH_MISMATCH 而非读取期 CRC_MISMATCH（两个错误码都指向真实损坏）。
4. **数据描述符**：读侧同时接受带签名（PK\x07\x08）与无签名两种模式（按"紧随数据后字段值与实算 CRC/尺寸相符"验证）；写侧统一产出带签名模式。ZIP64 条目的描述符为 20 字节布局。
5. **ZIP64**：哨兵（0xFFFF/0xFFFFFFFF）触发定位器 → EOCD64 链路；扩展字段按哨兵占位顺序消费，**多余尾随字节容忍**（对齐 Python zipfile——Info-ZIP 等真实写入器会在非哨兵字段也写全量 8 字节值）。机会式定位器探测兼容恒写 ZIP64 结构的写入器。
6. **EOCD 扫描**：候选需过双校验（签名+注释长度恰好填满文件尾；CD 起点签名互证或 ZIP64 链路完整），失败继续向前扫——注释内恰好落在文件尾的伪 PK\x05\x06 记录因此被正确跳过。ZIP64 链路失败的候选先记录，穷尽后作为最终错误抛出。
7. **写入器**：确定性输出（固定 DOS 时间戳）；`opts.descriptor`（bit3+带签名描述符）与 `opts.zip64`（强制全链路：EOCD64+定位器+每条目双头 8 字节扩展字段）作为任务书签名的可加性扩展；尺寸/偏移/条目数越界自动升级 ZIP64。
8. **合成 >4GB 映像**（不真写 4GB）：LFH+CD 双哨兵 + 8 字节扩展字段，entries 元数据反映 64 位尺寸；读取该条目按设计抛 BAD_DATA（声明值与真实数据不符是合成映像的本质）。
9. **内存防线**：inflate 的 sizeHint 封顶 256MB（损坏登记值不触发 4GB 预分配）；输出长度受登记值约束。

### 编码坑清单（任务书点名）

1. **CP437 高半区易错锚点**：0x9E=₧(U+20A7)、0xFE=NBSP(U+00A0)（源码里写成普通空格会静默错）、0xE5=µ(U+00B5)（不是 0xE6——0xE6 是 τ）。测试曾把锚点写错（0xE6 期待 µ），表是对的、断言错了，靠独立断言复核发现。
2. **EFS 位语义**：未置 bit11 的名字按 CP437 解释——**即使字节流明显是 UTF-8**。adm-zip 0.6.1 写非 ASCII 名正确置位；GitHub zipball 全部 EFS+UTF-8；写侧不置位的"历史兼容"产出在本库不存在。
3. **adm-zip 读侧重排**：0.6.1 读取时按 `entryName.toLowerCase().localeCompare` **排序条目**（zipFile.js sortEntries，noSort 选项可关）。zip 格式不定义条目顺序，差分按名字集合对拍，不按位置。
4. **adm-zip 不支持重名条目**：addFile 同名**替换**，读取含重名档案抛 DUPLICATE_ENTRY。任务书差分 1 要求"重名"——oracle 立场如此，处理：重名语义由自有 writeZip→readZip 往返覆盖（两条都在、read 取第一个），adm-zip 的拒绝行为契约化为断言。
5. **目录条目数据矛盾**：尾斜杠名配非空数据是矛盾输入；写侧强制清空（目录条目按定义无数据）。差分生成器曾生成"目录+364 字节数据"导致三向差分失败——修生成器而非放宽口径。
6. **unzip -Z1 与 UTF-8**：Info-ZIP 6.00 对 EFS 名直接输出 UTF-8 字节，与我们解码后按 utf8 比较一致（express 语料的 `CCTV大赛上海分赛区.txt`、`snow ☃` 全对上）。
7. **LFH 与 CD 的 ZIP64 extra 相互独立**：哪个头的字段是哨兵，哪个头的 extra 才有对应项；LFH 没有盘号字段，消费时不能把 diskStart 当哨兵（曾因此对 Python 产物误报"缺盘号字段"）。
8. **extra 字段长度**：字段头里的 size 是**体长**（不含 4 字节头）。写侧曾把总长写进 size 且缓冲区少分配 4 字节——TypedArray 越界写静默吞掉，靠自家 reader + adm-zip + Python 三方同时报错才定位。

## 二、验收清单对照

| 任务书要求 | 状态 |
|---|---|
| `npm test && npm run typecheck` 全绿 | ✓ **115/115**（15 文件：移植 16 + 核心 28 + ZIP64 10 + 差分 1×8 片 12 + 语料 40 + 坏档 3 + 性能 5 + smoke 1） |
| 差分 1：adm-zip 2000 组三方向 | ✓ 8 分片 × 250 组（种子 20260101..+7 可复现），我写它读/它写我读/混合链逐字节相等；名字池含中文/emoji/尾斜杠目录/深路径(20-44 段)；50MB 随机、100MB 全零（deflate）、100MB stored 边界双向 |
| 差分 2：10 个真实 zip + unzip -l | ✓ 10/10（express/requests/is/lite zipball、SQLite tools、ripgrep、Node v20、NuGet nupkg、Maven jar、PyPI whl），判据 `unzip -t` + `unzip -Z1` 名字集一致 + 全条目 CRC + adm-zip 互证；语料 manifest 含 sha256/出处/许可，大文件不入库 |
| 差分 3：ZIP64 边界双向 | ✓ 我们强制 ZIP64 输出 ↔ adm-zip ↔ CPython force_zip64 三方互读；合成 >4GB 尺寸映像（LFH+CD 双哨兵）解析出 64 位元数据 |
| 差分 4：坏档 ≥800 | ✓ **约 1250 条**定向变异（EOCD 截断 40 档×5、追加垃圾、注释长度、条目数/CD 偏移/尺寸 30 随机×4 基线、CD/LFH 逐字段×多值、数据区翻转、定位器/EOCD64 破坏）全部抛指定 ZipError.code；另加 2000 次随机位翻转模糊（抛 ZipError 或无害成功，不挂死） |
| deflate 移植出处注释 + 单元随迁 | ✓ 6 文件头部出处块 + `tests/deflate-port.test.ts` 16 条 |
| Web UI 单文件部署（zip-lab） | ✓ `npm run build:web` → dist/web/index.html 38.8KB 单文件；浏览器实测：解析/树/JSON 中文预览/hex 预览/取消勾选重打包/坏档错误码显示；已部署 Cloudflare Pages |
| REPORT.md 完整（编码坑清单） | ✓ 本文 |
| 停止规则：加密/分卷/自解压/CP437 外 OEM 不做 | ✓ bit0/bit6 只解析标志抛 ENCRYPTED；方法表只认 0/8；无分卷/SFX 逻辑 |

性能（单跑）：deflate 文本 119.6 MB/s（L6，压缩率 0.6%）、deflate 伪随机 8.5 MB/s（L1）、inflate 462 MB/s、crc32 244 MB/s、500 条目档案解析 <100ms。

## 三、已知限制

1. **加密条目**（bit0/bit6）：解析期整档拒绝（报 ENCRYPTED），不支持解密（任务书停止规则）。
2. **压缩方法**：只支持 stored(0)/deflate(8)，其他方法（bzip2/LZMA/zstd…）解析期报 BAD_METHOD。
3. **多盘档案**：EOCD 盘号字段忽略（单盘假设）；`diskStart` 哨兵消费但不用。
4. **Unicode Path extra（0x7075）**：不解析（任务书方言范围外，UTF-8/EFS 已覆盖主语义）。
5. **CP437 只解码不编码**：写侧不产出 CP437 名。
6. **分卷/自解压壳**：不做；带前置数据的 SFX 档案不在支持范围。
7. **u64 数值域**：≤ 2^53（Number 安全整数），实际受内存限制远小于此。
8. **perf 下限按并行环境标定**：`npm test` 全量并行时 worker 抢占 CPU，吞吐约为单跑的 1/2~1/3，断言下限以并行安全值设置。
9. **测试对语料的网络依赖**：克隆后首次需 `node scripts/fetch-corpus.mjs` 抓取差分 2 语料（缺失时对应 describe.skip，不假装通过）。

## 四、博客素材要点

1. **"逐字节 diff 是移植的唯一可信验收"**——人肉转写 1157 行代码，diff 抓到一处 slicing-by-4 表派生笔误（T2/T3 写成 T1/T2），肉眼与单元测试都放过了它（往返测试对"部分错误表"可能恰好通过——CRC 表错但已知锚点全过是运气），三方向差分才彻底兜底。
2. **ZIP 的三份"事实标准"互相打架**：APPNOTE 说非 EFS 名是 CP437，现实是"Windows 写 OEM/ANSI、Unix 写 UTF-8 且常忘置位、adm-zip 读取还要 localeCompare 重排"。讲清楚"实现一个格式 = 实现 30 年兼容性债"。
3. **TypedArray 越界写静默吞字节**——ZIP64 extra 少分配 4 字节，csize 尾部被吞，三裁判（自家 reader/adm-zip/CPython）同时报不同的错。教训：字节级协议解析里，"写入成功"不等于"写入到位"。
4. **EOCD 扫描的双校验设计**——注释里的伪 PK\x05\x06 恰好 22 字节落在文件尾时会完美冒充 EOCD，必须"注释长度与位置互证 + CD 签名互证 + 失败续扫"三层才稳。
5. **数据描述符的"两种模式"考据**——PK\x07\x08 签名是可选的，无签名模式只能靠"读出来的值对不对得上"来确认；这是 ZIP 里少数"结构自证"的设计。
6. **合成 >4GB 映像的测试法**——ZIP64 测试不需要真 4GB 数据：哨兵占位 + 8 字节扩展字段可以声明任意尺寸，代价是 read() 必然 BAD_DATA（声明≠现实），元数据断言才是这类测试的正确目标。
7. **adm-zip 的 6 个反直觉行为**（读侧重排/重名替换+抛错/目录条目语义/EFS 处理/错误类型只有字符串/0.6.x 的 zip64 补丁史）——差分前先写"oracle 行为探针"能省一半对拍调试时间。
8. **CP437 0xFE 是 NBSP 不是空格**——源码里肉眼无法分辨的两个字符，靠 codePoint 断言钉死；0x9E=₧（西班牙比索符号）这种"化石码点"是活着的 DOS 时代标本。
9. **差分 2000 组的规模工程学**——8 分片并行 + 种子可复现 + 尺寸分布偏斜（75% <4KB 保速度、尾部探到 100MB），3.4 分钟跑完；比"跑一次 100GB"更有效的覆盖是"分布化的 2000 组小案例 + 少量极端边界"。
