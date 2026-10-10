# -*- coding: utf-8 -*-
"""给构建产物打补丁：媒体生成不再因客户端断开而中止。

背景：/api/ai/media/generate 是同步长请求（豆包真实浏览器生成 5~10 分钟）。
原实现里 res close / req aborted / socket close 都会 controller.abort()，
而前端一旦刷新画布、切换视图或节点组件卸载，连接就会断开 —— 生成结果被直接丢弃：
RPA 是独立进程，它照旧跑完并落盘，但 Toonflow 这边不归档、不写回节点（实测踩过）。

本补丁把这三处 abort 回调改成空操作：连接断了也继续生成，结果照常写进工作区，
节点可从「媒体历史」里找回。
"""
import os
import sys

TARGET = os.path.join("build", "server", "index.js")

OLD = ('o=new AbortController,l=()=>o.abort();t.once("close",l),e.once("aborted",l),'
       'e.socket.once("close",l);try{let u=await Le.mediaGeneration.generateMedia(s,r,a.data,o.signal);')

NEW = ('o=new AbortController,l=()=>{};t.once("close",l),e.once("aborted",l),'
       'e.socket.once("close",l);try{let u=await Le.mediaGeneration.generateMedia(s,r,a.data,o.signal);')


def main():
    if not os.path.exists(TARGET):
        print("找不到 %s" % TARGET)
        return 1
    with open(TARGET, encoding="utf-8") as fh:
        data = fh.read()

    count = data.count(OLD)
    print("匹配到 %d 处" % count)
    if count == 0:
        print("已经打过补丁，或产物结构变化，未做修改")
        return 0
    if count != 1:
        print("匹配数不为 1，出于安全不修改")
        return 1

    with open(TARGET, "w", encoding="utf-8") as fh:
        fh.write(data.replace(OLD, NEW))
    print("补丁已应用：媒体生成不再随客户端断开而中止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
