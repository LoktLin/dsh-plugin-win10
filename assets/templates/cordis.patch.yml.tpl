# {{NAME}} — profile bundle patch
#
# 这个文件随 npm 包一起发布，被 `dsh plugin --profile web add {{NAME}}` 消费：
# 把本插件作为一个 entry 插进 web profile 的 cordis 入口列表。
# 卸载插件时这一行会被移除；要临时禁用而不卸载，改 profile 侧
# `~/.dsh/profiles/web/cordis.patch.yml` 里那条的 `disabled: true`，然后重启 dsh web。
- insert:
    - id: {{NAME}}
      name: '{{NAME}}'
