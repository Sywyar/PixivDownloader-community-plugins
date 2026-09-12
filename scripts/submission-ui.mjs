import { createInterface } from 'node:readline/promises';
export const locales = ['zh-CN', 'en-US', 'zh-Hant', 'ja-JP', 'ko-KR'];

// 向导独立运行；文本按操作字段提供，不根据投稿 schema 生成表单。
const messages = {
    language: ['选择语言', 'Choose a language', '選擇語言', '言語を選択', '언어 선택'],
    choose: ['请选择编号', 'Choose a number', '請選擇編號', '番号を選択', '번호 선택'],
    confirm: ['确认后输入 YES，取消请直接回车', 'Type YES to confirm; Enter cancels', '確認後輸入 YES，取消請直接按 Enter', '確認する場合は YES、キャンセルは Enter', '확인하려면 YES 입력, 취소하려면 Enter'],
    operation: ['社区操作', 'Community operation', '社群操作', 'コミュニティ操作', '커뮤니티 작업'],
    publish: ['发布或更新插件', 'Publish or update a plugin', '發布或更新外掛', 'プラグインの公開・更新', '플러그인 게시 또는 업데이트'],
    YANK: ['隐藏版本（YANK）', 'Hide a version (YANK)', '隱藏版本（YANK）', 'バージョンを非表示（YANK）', '버전 숨기기 (YANK)'],
    UNYANK: ['恢复隐藏版本（UNYANK）', 'Restore a hidden version (UNYANK)', '復原隱藏版本（UNYANK）', '非表示を解除（UNYANK）', '숨긴 버전 복원 (UNYANK)'],
    REVOKE: ['撤销版本并阻止安装、启动（REVOKE）', 'Revoke a version and block installation and startup (REVOKE)', '撤銷版本並阻止安裝、啟動（REVOKE）', 'バージョンを失効し、インストール・起動を禁止（REVOKE）', '버전 철회 및 설치·시작 차단 (REVOKE)'],
    transfer: ['发起或接受所有权转移', 'Propose or accept an ownership transfer', '發起或接受所有權轉移', '所有権移転の提案・承認', '소유권 이전 제안 또는 수락'],
    project: ['选择插件工程', 'Select the plugin project', '選擇外掛工程', 'プラグインプロジェクトを選択', '플러그인 프로젝트 선택'],
    profile: ['选择构建工具', 'Select the build tool', '選擇建置工具', 'ビルドツールを選択', '빌드 도구 선택'],
    trust: ['模型查询会执行当前工程的 Maven/Gradle/sbt 配置和插件，拥有当前用户的本地权限。仅在信任该工程时确认。', 'Model queries execute this project’s Maven/Gradle/sbt configuration and plugins with your local user permissions. Confirm only if you trust this project.', '模型查詢會執行此工程的 Maven/Gradle/sbt 設定與外掛，擁有目前使用者的本機權限。僅在信任此工程時確認。', 'モデルの照会は現在のユーザー権限で Maven/Gradle/sbt の設定やプラグインを実行します。このプロジェクトを信頼する場合のみ確認してください。', '모델 조회는 현재 사용자 권한으로 프로젝트의 Maven/Gradle/sbt 설정과 플러그인을 실행합니다. 신뢰하는 프로젝트만 확인하세요.'],
    artifact: ['选择最终安装包', 'Select the final installation package', '選擇最終安裝套件', '最終インストールパッケージを選択', '최종 설치 패키지 선택'],
    risk: ['核对从最终包读取的执行模式和能力声明。需要修改时请取消并修改源码；此处不能编辑声明。', 'Review the execution mode and capability declaration read from the final package. Cancel and edit the source if they need changes.', '核對最終套件的執行模式與能力宣告；需要修改時請取消並修改原始碼。', '最終パッケージから読み取った実行モードと能力宣言を確認してください。変更する場合はキャンセルし、ソースを修正してください。', '최종 패키지에서 읽은 실행 모드와 기능 선언을 확인하세요. 변경이 필요하면 취소하고 소스를 수정하세요.'],
    rebuildPackage: ['请修改源码、提交并重新构建和签名，再运行向导。', 'Edit and commit the source, rebuild and sign, then run the wizard again.', '請修改原始碼、提交並重新建置及簽名，再執行精靈。', 'ソースを修正してコミットし、再ビルド・署名後に再実行してください。', '소스를 수정하고 커밋한 뒤 다시 빌드 및 서명하고 마법사를 실행하세요.'],
    publisher: ['确认 publisherId', 'Confirm publisherId', '確認 publisherId', 'publisherId を確認', 'publisherId 확인'],
    display: ['发布者显示名称', 'Publisher display name', '發布者顯示名稱', '発行者の表示名', '게시자 표시 이름'],
    owner: ['发布主体', 'Publisher account', '發布主體', '発行アカウント', '게시 계정'],
    personal: ['当前个人账号', 'Current personal account', '目前個人帳號', '現在の個人アカウント', '현재 개인 계정'],
    organization: ['当前账号加入的组织', 'An organization you belong to', '目前帳號加入的組織', '所属する組織', '가입한 조직'],
    representation: ['确认您有权代表此组织发布和管理该插件；组织代表权仍需受保护审核。', 'Confirm that you may publish and manage this plugin for this organization. Protected review must still verify your authority.', '確認您有權代表此組織發布及管理外掛；代表權仍需受保護審核。', 'この組織を代表して公開・管理する権限を確認してください。権限は保護された審査でも確認されます。', '이 조직을 대표하여 플러그인을 게시하고 관리할 권한을 확인하세요. 보호된 검토에서도 권한을 확인합니다.'],
    release: ['选择公开 Release', 'Select a public Release', '選擇公開 Release', '公開 Release を選択', '공개 Release 선택'],
    packageUrl: ['插件包公开 HTTPS 地址', 'Public HTTPS package URL', '外掛套件公開 HTTPS 位址', 'パッケージの公開 HTTPS URL', '패키지 공개 HTTPS 주소'],
    asset: ['选择 Release 附件', 'Select a Release asset', '選擇 Release 附件', 'Release の添付ファイルを選択', 'Release 첨부 파일 선택'],
    publicKey: ['配套 public-key.pem 路径', 'Matching public-key.pem path', '配套 public-key.pem 路徑', '対応する public-key.pem のパス', '대응하는 public-key.pem 경로'],
    privateKey: ['private-key.pem 路径（源码仓库及临时目录之外）', 'private-key.pem path (outside source repositories and temporary directories)', 'private-key.pem 路徑（原始碼儲存庫及暫存目錄之外）', 'private-key.pem のパス（ソースリポジトリ・一時ディレクトリの外）', 'private-key.pem 경로 (소스 저장소와 임시 디렉터리 외부)'],
    keyDirectory: ['新密钥目录（源码仓库及临时目录之外）', 'New key directory (outside source repositories and temporary directories)', '新金鑰目錄（原始碼儲存庫及暫存目錄之外）', '新しい鍵ディレクトリ（ソースリポジトリ・一時ディレクトリの外）', '새 키 디렉터리 (소스 저장소와 임시 디렉터리 외부)'],
    keyId: ['公钥标识 keyId', 'Public key identifier keyId', '公鑰識別碼 keyId', '公開鍵の識別子 keyId', '공개 키 식별자 keyId'],
    keyAction: ['密钥选择', 'Key selection', '金鑰選擇', '鍵の選択', '키 선택'],
    existingKey: ['使用现有密钥', 'Use an existing key', '使用既有金鑰', '既存の鍵を使用', '기존 키 사용'],
    generateKey: ['初始化新密钥并备份私钥与配套公钥', 'Generate a new key; back up both private and public files', '初始化新金鑰並備份私鑰與配套公鑰', '新しい鍵を生成し、秘密鍵と公開鍵をバックアップ', '새 키 생성 후 개인 키와 공개 키 모두 백업'],
    reason: ['选择原因', 'Select a reason', '選擇原因', '理由を選択', '사유 선택'],
    explanation: ['说明', 'Explanation', '說明', '説明', '설명'],
    plugin: ['选择已登记插件', 'Select a registered plugin', '選擇已登記外掛', '登録済みプラグインを選択', '등록된 플러그인 선택'],
    version: ['选择已发布版本', 'Select a published version', '選擇已發布版本', '公開済みバージョンを選択', '게시된 버전 선택'],
    optionalKey: ['是否提供当前活动密钥的签名证明？', 'Provide proof using the current active key?', '是否提供目前活動金鑰的簽名證明？', '現在の有効な鍵で署名しますか？', '현재 활성 키의 서명 증명을 제공할까요?'],
    license: ['确认 SPDX 许可证表达式', 'Confirm the SPDX license expression', '確認 SPDX 授權條款表達式', 'SPDX ライセンス式を確認', 'SPDX 라이선스 표현식 확인'],
    licenseFiles: ['许可证文件路径，相对 Git 根目录，多个路径用逗号分隔', 'License file paths relative to the Git root, separated by commas', '授權條款檔案路徑，相對 Git 根目錄，以逗號分隔', 'Git ルートからのライセンスファイルの相対パス（カンマ区切り）', 'Git 루트 기준 라이선스 파일 경로 (쉼표로 구분)'],
    licenseTemplate: ['选择要创建的许可证文本', 'Select a license text to create', '選擇要建立的授權條款文字', '作成するライセンス本文を選択', '생성할 라이선스 본문 선택'],
    year: ['版权年份', 'Copyright year', '版權年份', '著作権表示の年', '저작권 연도'],
    copyright: ['版权所有者（请确认真实权利人）', 'Copyright holder (confirm the actual rights holder)', '著作權人（請確認實際權利人）', '著作権者（実際の権利者を確認）', '저작권자 (실제 권리자 확인)'],
    rebuild: ['请提交许可证变更，重新构建并签名后再次运行向导。', 'Commit the license change, rebuild and sign, then run the wizard again.', '請提交授權條款變更，重新建置並簽名後再次執行精靈。', 'ライセンスの変更をコミットし、再ビルド・署名後にウィザードを実行してください。', '라이선스 변경을 커밋하고 다시 빌드 및 서명한 뒤 실행하세요.'],
    locale: ['市场文案默认语言标签', 'Default language tag for market text', '市集文字預設語言標籤', 'マーケット表示の既定言語タグ', '마켓 문구 기본 언어 태그'],
    name: ['插件显示名称', 'Plugin display name', '外掛顯示名稱', 'プラグインの表示名', '플러그인 표시 이름'],
    summary: ['插件简介', 'Plugin summary', '外掛簡介', 'プラグインの概要', '플러그인 요약'],
    description: ['详细说明（可留空）', 'Description (optional)', '詳細說明（可留空）', '詳細説明（任意）', '상세 설명 (선택 사항)'],
    category: ['选择分类', 'Select a category', '選擇分類', 'カテゴリを選択', '분류 선택'],
    tags: ['选择标签编号，逗号分隔，可留空', 'Select tag numbers, separated by commas; optional', '選擇標籤編號，以逗號分隔，可留空', 'タグの番号をカンマ区切りで選択（任意）', '태그 번호 선택, 쉼표 구분 (선택 사항)'],
    icon: ['图标文件路径（可留空）', 'Icon file path (optional)', '圖示檔案路徑（可留空）', 'アイコンファイルのパス（任意）', '아이콘 파일 경로 (선택 사항)'],
    screenshots: ['截图文件路径，逗号分隔（可留空）', 'Screenshot paths, separated by commas (optional)', '截圖檔案路徑，以逗號分隔（可留空）', 'スクリーンショットのパス（カンマ区切り、任意）', '스크린샷 경로, 쉼표 구분 (선택 사항)'],
    alt: ['图片替代文本', 'Image alternative text', '圖片替代文字', '画像の代替テキスト', '이미지 대체 텍스트'],
    targetLogin: ['目标 GitHub 个人或组织 login', 'Target GitHub user or organization login', '目標 GitHub 個人或組織 login', '移転先の GitHub ユーザー・組織 login', '대상 GitHub 사용자 또는 조직 login'],
    proposal: ['选择现有转移请求，或发起新请求', 'Select a transfer request or propose a new one', '選擇既有轉移請求，或發起新請求', '既存の移転申請を選択、または新規提案', '기존 이전 요청 선택 또는 새 요청 제안'],
    newProposal: ['发起新请求', 'New proposal', '發起新請求', '新しい提案', '새 요청'],
    mode: ['选择转移方式', 'Select the transfer mode', '選擇轉移方式', '移転モードを選択', '이전 방식 선택'],
    evidence: ['恢复证据文件路径，逗号分隔', 'Recovery evidence file paths, separated by commas', '復原證據檔案路徑，以逗號分隔', '復旧の証拠ファイルのパス（カンマ区切り）', '복구 증거 파일 경로, 쉼표 구분'],
    preview: ['核对完整预览；确认后创建提交、普通推送并创建 Ready PR。', 'Review the complete preview. Confirmation creates a commit, pushes normally and opens a Ready PR.', '核對完整預覽；確認後建立提交、一般推送及 Ready PR。', 'プレビュー全体を確認してください。確認後にコミット、通常の push、Ready PR の作成を行います。', '전체 미리 보기를 확인하세요. 확인하면 커밋, 일반 push 및 Ready PR을 생성합니다.'],
    cancelled: ['已取消', 'Cancelled', '已取消', 'キャンセルしました', '취소됨'],
    cleanupFailed: ['临时工作目录清理失败，操作结果保持有效；请关闭占用程序后删除此目录。', 'Temporary workspace cleanup failed. The operation result is still valid; close programs using this folder, then delete it.', '暫存工作目錄清理失敗，操作結果仍有效；請關閉占用程式後刪除此目錄。', '一時フォルダーを削除できませんでした。操作結果は有効です。使用中のプログラムを閉じてから削除してください。', '임시 폴더를 삭제하지 못했습니다. 작업 결과는 유효합니다. 폴더를 사용 중인 프로그램을 닫고 삭제하세요.'],
    original: ['已存在相同请求或已发布的相同包，返回原记录。', 'The same request or package was already processed. Returning the original record.', '相同請求或套件已處理，傳回原紀錄。', '同じ申請またはパッケージは処理済みです。元の記録を返します。', '동일한 요청 또는 패키지가 처리되어 원본 기록을 반환합니다.'],
    submitted: ['PR 已准备好，请等待仓库审核。', 'The PR is ready for repository review.', 'PR 已準備好，請等候儲存庫審核。', 'PR を作成しました。リポジトリでの審査をお待ちください。', 'PR이 준비되었습니다. 저장소 검토를 기다려 주세요.'],
    failed: ['向导已停止，请根据错误码检查输入后重试。', 'The wizard stopped. Check the input using this error code, then retry.', '精靈已停止，請依錯誤碼檢查輸入後重試。', 'ウィザードを停止しました。エラーコードを確認し、入力を修正して再実行してください。', '마법사가 중지되었습니다. 오류 코드를 확인하고 입력을 수정한 뒤 다시 시도하세요.'],
};

export async function terminal(input = process.stdin, output = process.stdout) {
    const rl = createInterface({ input, output });
    let index = 1;
    const visible = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
    const say = (key, value) => output.write(messages[key][index] + (value === undefined ? '' : '\n' + JSON.stringify(value, null, 2)) + '\n');
    const ask = async (key, fallback = '') => {
        const value = await rl.question(messages[key][index] + (fallback ? ` [${visible(fallback)}]` : '') + ': ');
        return value.trim() || fallback;
    };
    const select = async (key, options, label = value => String(value)) => {
        if (!options.length) throw new Error('NO_SELECTABLE_VALUES');
        if (options.length === 1) return options[0];
        say(key);
        options.forEach((value, i) => output.write(`${i + 1}. ${visible(label(value))}\n`));
        const value = await ask('choose');
        const selected = Number(value);
        if (!/^[1-9][0-9]*$/u.test(value) || selected > options.length) throw new Error('SELECTION_INVALID');
        return options[selected - 1];
    };
    index = locales.indexOf(await select('language', locales));
    const confirm = async (key, value) => { say(key, value); return await ask('confirm') === 'YES'; };
    return { ask, say, select, confirm, text: key => messages[key][index], close: () => rl.close() };
}
