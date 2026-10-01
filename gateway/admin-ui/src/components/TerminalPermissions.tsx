/** Project terminal authorization editor; user qualification lives on the user detail page. */
import { getTerminalPolicy, setTerminalPolicy } from '../api.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function TerminalPermissions() {
  return <ResourcePermissions name="终端" read={getTerminalPolicy} write={setTerminalPolicy} kinds={['project']}
    description="默认不授权。项目空间同时需要用户资格、项目授权和可写成员身份。终端仅创建者可读写；管理员只能列出和关闭他人的终端。撤权后等待进程清理，隐藏标签不会结束进程。"
    saved="终端授权已保存；项目空间仍需同时具备用户资格、项目授权和可写成员身份。" />
}
