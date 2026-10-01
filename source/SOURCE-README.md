# 酒馆读卡 0.1.6 对应源码

这是独立 SillyTavern 扩展的源码与共享读卡模块，不包含 Mac 应用、用户数据或密钥。
使用 Node.js 22，在本目录执行：

```bash
npm ci
npm run test:reader-extension
npm run build:reader-extension
npm run package:reader-extension
```

构建输出位于 dist-extensions/jiuguan-reader/，安装步骤见 extensions/jiuguan-reader/README.md。
package.json 保留上游桌面项目的其他工作流；本源码包只交付读卡扩展，使用以上带 reader-extension 的命令。
GPL-3.0-or-later；许可证与第三方声明在目录根部。
