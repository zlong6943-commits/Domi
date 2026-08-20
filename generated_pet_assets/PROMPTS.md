# Domi 专属宠物提示词模板

本套素材使用 Codex 内置 ImageGen 生成，不在 Domi 应用中配置或保存 API Key。

## 统一角色模板

```text
Use case: illustration-story
Asset type: Domi desktop pet state sprite — {STATE}

Input image:
Image 1 is the approved master character and the ONLY identity, clothing, proportion, and style reference.

Primary request:
Create the same dog in this state: {ACTION_AND_EXPRESSION}.

Identity lock:
Preserve exactly the same Yorkie/toy-terrier identity, golden-cream fluffy fur distribution,
darker upright ears, face shape, eye size and spacing, black oval nose, blue-and-white plaid
oversized sailor bow and navy harness, chibi head-to-body ratio, watercolor and colored-pencil
texture, brown hand-drawn outlines, and warm low-saturation palette from Image 1.

Composition:
Exactly one complete dog, full body visible, centered square sprite, approximately the same
character scale as Image 1, 12% clear padding on every side, strong readable silhouette.
Keep all ears, paws, tail, bow, harness, and any requested prop inside the canvas.

Background:
Real transparent alpha background. Do not draw a checkerboard. No backdrop, floor, ground line,
cast shadow, frame, or scenery.

Constraints:
This must look like another animation state of the exact same approved character, not a redesign.
Clean sprite-safe edges.

Avoid:
identity drift, breed changes, Shiba traits, different clothing, realistic proportions, extra limbs,
duplicate paws, text, letters, watermark, logo, unnecessary props, photorealism, 3D.
```

## 九种状态动作

- `HAPPY`：夸张地向上小跳，两只前爪向外抬起，后爪靠拢，尾巴高高摇动；歪头、张嘴微笑并露出一点粉色舌头。
- `BREAK REMINDER`：端正坐好，抬起一只前爪向用户轻轻招手；耳朵竖起，大眼睛关心地看着用户，露出鼓励的小微笑。
- `TAKING A BREAK / STRETCHING`：做夸张可爱的伸懒腰动作；两只前爪向前伸，胸口压低，臀部抬高，尾巴翘起，闭眼满足地微笑。
- `HYDRATION REMINDER`：坐着用两只前爪抱住一只小巧、无文字的浅蓝色水杯并递向用户；杯口能看到清水，微微吐舌。
- `SLEEPING`：侧躺蜷成松软的小月牙，前爪收拢并托住头，尾巴自然围住身体；闭眼、放松微笑，蓝色格纹蝴蝶结仍清楚可见。
- `WALKING`：三分之四侧向活泼小跑，一只前爪向前、对侧后爪跟上；身体短而微微前倾，尾巴翘起，眼神期待又专注。不要画运动线。
- `WALKING CYCLE`：3×2 六帧步态表，依次表现左右前爪交替前伸、承重、身体升高、四脚收拢和另一侧落地；每一格必须改变腿部姿势与重心，不能重复同一张图。
- `RUNNING CYCLE`：3×2 六帧跑步表，依次表现落地压缩、后腿蹬地、前后腿伸展腾空、四脚收拢、下降和恢复接触；蝴蝶结、耳朵和尾巴随速度产生滞后。
- `POUNCING`：头部压低向前、两只短前爪同时向前下方伸出，后腿蓄力、尾巴抬起；目光集中在爪子前方，表情兴奋又调皮。不要把球画进宠物素材。

生成后需检查文件是否真的包含 Alpha 通道。若模型把棋盘格画进图片，应先删除与画布边缘连通的高亮中性色棋盘格，再制作循环 APNG。
