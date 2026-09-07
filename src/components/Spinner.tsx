// 本文件：等待模型响应时显示的转圈指示器组件。
import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import type React from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// 本组件：按固定间隔切换帧的转圈指示器，附带标签与中断提示。
/**
 * Ink re-renders on state change, so an interval that bumps an index is all a
 * spinner is. Claude Code's version also cycles the label word, which is the
 * cheapest possible way to make a wait feel shorter.
 * Ink 在状态变化时重渲染，所以转圈动画只需一个定时器递增帧下标。
 * Claude Code 还会轮换标签词——这是让等待显得更短的最省事做法。
 */
export function Spinner({ label }: { label: string }): React.ReactElement {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return (
    <Box marginTop={1}>
      <Text color="cyan">{FRAMES[frame]}</Text>
      <Text dimColor> {label}… (ctrl+c to interrupt)</Text>
    </Box>
  )
}
