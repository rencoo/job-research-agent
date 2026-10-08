# PDF 简历解析功能实施指南

> 创建时间: 2026-10-08  
> Issue: #4  
> 分支: `cursor/phase1-pdf-resume-parser-f634`

## 当前进度

### ✅ 已完成
1. 添加依赖: `pdf-parse` 和 `@types/pdf-parse`
2. 创建核心 PDF 解析服务 (`apps/server/src/pdf-parser.ts`)
   - `extractText`: 提取 PDF 文本
   - `validate`: 验证 PDF 文件
   - `cleanText`: 文本清理
3. 创建基础测试框架 (`apps/server/src/pdf-parser.test.ts`)

### 🚧 待完成

#### 1. 扩展数据模型
**文件**: `packages/contracts/src/core.ts`

```typescript
// 扩展 Profile 支持文件来源
export const ResumeSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("pdf"),
    filename: z.string(),
    artifactId: z.string(), // 引用存储的 PDF 文件
    extractedText: z.string(),
    pages: z.number(),
    uploadedAt: z.string(), // ISO timestamp
  }),
]);

export type ResumeSource = z.infer<typeof ResumeSourceSchema>;

// 更新 Profile Schema
export const ProfileInputSchema = z.object({
  // 保持向后兼容：resumeText 仍然可用（文本模式）
  resumeText: z.string().optional(),
  // 新增：简历来源（支持 PDF）
  resumeSource: ResumeSourceSchema.optional(),
  // ... 其他字段不变
});
```

**迁移策略**:
- 读取时：如果 `resumeSource` 不存在，从 `resumeText` 构建文本类型的 source
- 写入时：同时支持 `resumeText`（向后兼容）和 `resumeSource`（新功能）

#### 2. 添加文件上传 API
**文件**: `apps/server/src/business-app.ts` 或新文件 `apps/server/src/file-upload.ts`

```typescript
// 使用 @fastify/multipart 处理文件上传
import multipart from "@fastify/multipart";
import { PDFParser } from "./pdf-parser";

app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1, // 单次只允许一个文件
  },
});

app.post("/api/profile/upload-resume", async (request, reply) => {
  const data = await request.file();
  
  if (!data) {
    return reply.code(400).send({
      error: { code: "validation", message: "未提供文件", retryable: false },
    });
  }

  // 验证文件类型
  if (data.mimetype !== "application/pdf") {
    return reply.code(400).send({
      error: {
        code: "validation",
        message: "只支持 PDF 文件",
        retryable: false,
      },
    });
  }

  // 读取文件到 Buffer
  const chunks: Buffer[] = [];
  for await (const chunk of data.file) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  // 验证 PDF
  const parser = new PDFParser();
  const validation = await parser.validate(buffer);
  if (!validation.valid) {
    return reply.code(400).send({
      error: {
        code: "validation",
        message: validation.reason ?? "PDF 文件无效",
        retryable: false,
      },
    });
  }

  // 提取文本
  const result = await parser.extractText(buffer);

  // 保存 PDF 文件到 artifacts
  // TODO: 实现文件存储逻辑（参考现有 artifact 存储）
  const artifactId = await saveArtifact(buffer, data.filename, "application/pdf");

  return reply.send({
    success: true,
    resumeSource: {
      type: "pdf",
      filename: data.filename,
      artifactId,
      extractedText: result.text,
      pages: result.pages,
      uploadedAt: new Date().toISOString(),
    },
  });
});
```

**依赖**: 需要安装 `@fastify/multipart`

```bash
pnpm add @fastify/multipart --filter @job-research/server
```

#### 3. 更新前端上传界面
**文件**: `apps/web/src/pages.tsx`

在 `EditableResume` 组件中添加文件上传选项：

```tsx
function EditableResume({ value, onChange, defaultEditing }) {
  const [uploadMode, setUploadMode] = useState<"text" | "file">("text");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      setUploadError("只支持 PDF 文件");
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/profile/upload-resume", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || "上传失败");
      }

      const result = await response.json();
      // 使用提取的文本更新简历
      onChange(result.resumeSource.extractedText);
      setUploadMode("text"); // 切换回文本模式查看
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="editable-field">
      <div className="resume-input-mode-switch">
        <button
          type="button"
          onClick={() => setUploadMode("text")}
          className={uploadMode === "text" ? "active" : ""}
        >
          文本输入
        </button>
        <button
          type="button"
          onClick={() => setUploadMode("file")}
          className={uploadMode === "file" ? "active" : ""}
        >
          上传 PDF
        </button>
      </div>

      {uploadMode === "text" ? (
        <textarea
          aria-label="当前简历"
          rows={12}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="粘贴完整简历文本..."
        />
      ) : (
        <div className="file-upload-area">
          <input
            type="file"
            accept="application/pdf"
            onChange={handleFileUpload}
            disabled={uploading}
          />
          {uploading && <p>正在处理 PDF...</p>}
          {uploadError && <p className="error">{uploadError}</p>}
          <p className="hint">支持 PDF 格式，最大 10MB</p>
        </div>
      )}
    </div>
  );
}
```

#### 4. 添加 CSS 样式
**文件**: `apps/web/src/styles.css`

```css
.resume-input-mode-switch {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.resume-input-mode-switch button {
  padding: 8px 16px;
  border: 1px solid #d2d2d7;
  background: white;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.2s;
}

.resume-input-mode-switch button.active {
  background: #0066cc;
  color: white;
  border-color: #0066cc;
}

.file-upload-area {
  padding: 32px;
  border: 2px dashed #d2d2d7;
  border-radius: 12px;
  text-align: center;
}

.file-upload-area input[type="file"] {
  margin-bottom: 16px;
}

.file-upload-area .hint {
  font-size: 13px;
  color: #6e6e73;
}

.file-upload-area .error {
  color: #d80000;
  margin-top: 8px;
}
```

#### 5. 更新持久化层
**文件**: `packages/database/src/business-repository.ts`

确保 Profile 存储支持新的 `resumeSource` 字段：

```typescript
// 在 profiles 表中添加可选的 JSON 列
// 迁移文件: packages/database/migrations/0005_resume_source.sql

ALTER TABLE profiles ADD COLUMN resume_source TEXT; -- JSON 存储 ResumeSource

-- 读取时的兼容逻辑
// 如果 resume_source 为 null，从 resumeText 构建
const profile = {
  ...row,
  resumeSource: row.resume_source
    ? JSON.parse(row.resume_source)
    : {
        type: "text",
        content: row.resumeText,
      },
};
```

#### 6. 添加端到端测试
**文件**: `apps/server/src/pdf-upload.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { buildServer } from "./app";
// ... 创建测试 PDF 文件
// ... 测试上传流程
// ... 测试错误处理
```

#### 7. 更新文档
**文件**: `README.md`

添加 PDF 上传功能说明：

```markdown
## 简历导入

支持两种方式导入简历：

1. **文本输入**：直接粘贴简历文本
2. **PDF 上传**：上传 PDF 格式简历（最大 10MB），系统自动提取文本

PDF 简历会被保存为 artifact，提取的文本用于分析。
```

## 技术决策

### 为什么选择 pdf-parse？
- ✅ 纯 JavaScript 实现，无需系统依赖
- ✅ 支持大多数 PDF 格式
- ✅ 轻量级，不需要外部服务
- ❌ 不支持扫描件 OCR（需要 Tesseract，见 Issue #5）

### 文件存储策略
遵循现有 artifact 存储模式：
- 计算文件哈希作为文件名（去重）
- 原子写入（先写临时文件，后重命名）
- 数据库引用，异步清理无引用文件

### 向后兼容性
- 保留 `resumeText` 字段支持现有 API
- `resumeSource` 为可选字段
- 旧数据读取时自动升级为文本类型 source

## 测试策略

### 单元测试
- ✅ PDF 解析器（文件验证、文本提取）
- 🚧 文件上传 API（multipart 处理、错误处理）
- 🚧 前端组件（文件选择、上传状态）

### 集成测试
- 🚧 完整上传流程（前端 → API → 持久化）
- 🚧 PDF 保存和检索
- 🚧 简历版本更新逻辑

### 测试数据
需要准备测试 PDF：
- `test-fixtures/valid-resume.pdf`: 标准简历
- `test-fixtures/large-resume.pdf`: 大文件（接近 10MB）
- `test-fixtures/corrupted.pdf`: 损坏文件
- `test-fixtures/encrypted.pdf`: 加密文件

## 性能考虑

- PDF 解析可能较慢（3-10 秒），需要 loading 状态
- 考虑添加进度提示
- 大文件限制在 10MB，避免阻塞服务器
- 提取的文本可能很长，考虑前端预览截断

## 安全考虑

- ✅ 文件大小限制（10MB）
- ✅ 文件类型验证（MIME type + 文件头）
- ✅ 单次只允许一个文件
- 🚧 文件扫描（可选：集成杀毒）
- 🚧 提取文本长度限制（避免过大）

## 后续优化

1. **OCR 支持** (Issue #5): 对于扫描件 PDF，集成 Tesseract
2. **DOCX 支持**: 添加 Word 文档解析
3. **文本预处理**: 智能识别简历各部分（教育、经历、技能）
4. **批量上传**: 支持一次上传多个岗位 JD 的 PDF
5. **拖拽上传**: 改进 UI，支持拖拽文件

## 参考资料

- [pdf-parse 文档](https://www.npmjs.com/package/pdf-parse)
- [@fastify/multipart 文档](https://github.com/fastify/fastify-multipart)
- [现有 artifact 存储实现](../packages/database/src/repository.ts)
