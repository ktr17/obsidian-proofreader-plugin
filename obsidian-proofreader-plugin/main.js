const { Plugin, Notice, MarkdownView } = require("obsidian");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

// .envファイルを読み込む関数
function loadEnv(envPath) {
  const env = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach((line) => {
      line = line.trim();
      // コメント行と空行をスキップ
      if (!line || line.startsWith("#")) return;
      const [key, ...valueParts] = line.split("=");
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join("=").trim();
      }
    });
  }
  return env;
}

module.exports = class ProofreadPlugin extends Plugin {
  async onload() {
    console.log("Claude Code校正プラグイン（非同期対応）読み込み完了");

    // ここではもう PATH の取得は不要。node と cli.js を直接叩く。
    await this.initClaudePath();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.addProofButton())
    );
    this.addProofButton();

    // エディタのコンテキストメニューに「選択範囲を校正」を追加
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        // 選択範囲がある場合のみメニュー項目を追加
        if (editor.somethingSelected()) {
          menu.addItem((item) => {
            item
              .setTitle("選択範囲を校正")
              .setIcon("pencil")
              .onClick(async () => {
                await this.proofreadSelection(editor);
              });
          });
        }
      })
    );
  }

  async initClaudePath() {
    // .envファイルのパスを取得（プラグインディレクトリ内）
    // Obsidianプラグインでは__dirnameは使えないので、this.manifestを使用
    const basePath = this.app.vault.adapter.basePath;
    const pluginDir =
      this.manifest.dir ||
      path.join(this.app.vault.configDir, "plugins", this.manifest.id);

    // 相対パスの場合は絶対パスに変換
    const absolutePluginDir = path.isAbsolute(pluginDir)
      ? pluginDir
      : path.join(basePath, pluginDir);

    const envPath = path.join(absolutePluginDir, ".env");

    console.log("Vaultベースパス:", basePath);
    console.log("プラグインディレクトリ（相対）:", pluginDir);
    console.log("プラグインディレクトリ（絶対）:", absolutePluginDir);
    console.log(".envパス:", envPath);
    console.log(".envファイル存在確認:", fs.existsSync(envPath));

    const env = loadEnv(envPath);
    console.log("読み込まれた環境変数:", env);

    const platform = os.platform();

    if (platform === "win32") {
      defaultNodePath = "node";
      defaultClaudeJsPath =
        "C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    } else if (platform === "linux") {
      defaultNodePath = "node";
      defaultClaudeJsPath = "claude";
    }

    this.nodePath = env.NODE_PATH;
    this.claudeJsPath = env.CLAUDE_JS;
    this.modelName = env.MODEL_NAME;

    console.log("Nodeパス:", this.nodePath);
    console.log("Claude CLIパス:", this.claudeJsPath);
    console.log("モデル名:", this.modelName);
  }

  async proofreadSelection(editor) {
    const selectedText = editor.getSelection();
    if (!selectedText) {
      new Notice("テキストが選択されていません");
      return;
    }

    // 通知を表示
    new Notice("選択範囲を校正中...");

    try {
      const result = await this.runClaudeProofread(selectedText);
      // 選択範囲を校正結果で置き換え
      editor.replaceSelection(result);
      new Notice("選択範囲の校正完了！");
    } catch (err) {
      console.error(err);
      new Notice("エラー: " + (err?.message || String(err)));
    }
  }

  addProofButton() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const toolbar = view.containerEl.querySelector(".view-header");
    if (!toolbar) return;

    // 重複防止
    const oldBtn = toolbar.querySelector(".proofread-button");
    if (oldBtn) oldBtn.remove();

    const btn = document.createElement("button");
    btn.className = "proofread-button";
    btn.textContent = "校正";
    Object.assign(btn.style, {
      marginLeft: "8px",
      background: "var(--interactive-accent)",
      color: "white",
      border: "none",
      borderRadius: "4px",
      padding: "4px 8px",
      cursor: "pointer",
      transition: "opacity 0.3s ease",
    });

    btn.addEventListener("click", async () => {
      const editor = view.editor;
      if (!editor) return new Notice("エディタが見つかりません");

      const text = editor.getValue();

      // UI 即時更新
      btn.disabled = true;
      btn.style.opacity = "0.6";
      const originalText = btn.textContent;
      btn.textContent = "校正中…";
      new Notice("Claude Codeで校正中...");

      try {
        const result = await this.runClaudeProofread(text);
        editor.setValue(result);
        new Notice("校正完了！");
      } catch (err) {
        console.error(err);
        new Notice("エラー: " + (err?.message || String(err)));
      } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.textContent = originalText;
      }
    });

    toolbar.appendChild(btn);
  }

  async runClaudeProofread(text) {
    const prompt = `
      対象テキストは、音声入力で行った読書メモです。以下のルールに従って校正してください。
      結果以外の文章は出力しないでください。対象テキストの校正結果のみを出力してください。
      ## 修正の方針

      ### 1. 誤字脱字の修正
      音声入力特有の誤変換を修正してください。
      本の内容を読み取り、誤字を推測して適切に直してください。

      例：
      - 「プログラミングの基礎をご照会します」→「プログラミングの基礎をご紹介します」
      - 「このツールを仕様して開発を進めます」→「このツールを使用して開発を進めます」
      - 「データベースにアクセス強方法を説明します」→「データベースにアクセスする方法を説明します」
      - 「機能をカスタマイズで切ます」→「機能をカスタマイズできます」

      ### 2. 小見出しの作成
      メモ書きの区切りはページ番号で行っています。
      メモ書きの区切りの単位で「##」を用いて小見出しを作成してください。


      ### 3. 本から得た事実と自分の意見を明確に
      本から得た事実と自分の意見が書かれている。自分の意見には文頭に「💡」を付与しています。そこから改行までが意見を指しています。
      そのため、意見には「💡」マークをそのまま残して明確にしたい。

      ### 4. 口語的過ぎる言い回しを書き言葉に
      話し言葉特有の冗長な表現や、「〜なんか」「〜とか」「〜みたいな」などのカジュアル表現を、
      自然な書き言葉に直してください。
      ただし、**リズムや文体を極力維持し、ニュアンスを壊さないように**してください。

      ### 5. 文の意味や語調を変えない
      文体や語調は原文を尊重し、不必要な意訳は行わないこと。

      ### 6. 文法・句読点・助詞の微修正
      助詞の誤用、読点の補完、重複表現の整理など。

      ### 7. 修正は最小限に
      大幅な意訳は禁止。「人が軽く校正した程度」にとどめる。

      ### 8. 出力ルール
      本文のみ出力。空行・段落は維持。
      ページ番号は削除しないでください。

      ---
      対象テキスト：
      ${text}
      `.trim();

    return new Promise((resolve, reject) => {
      // ★ node で cli.js を叩く（最も安定）
      const command = `${this.nodePath} ${this.claudeJsPath} --model ${this.modelName}`;

      const child = exec(
        command,
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error)
            return reject(
              new Error("Claude Code 実行エラー: " + (stderr || error.message))
            );
          resolve(stdout.trim());
        }
      );

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
};
