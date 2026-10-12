<template>
  <div class="privacy">
    <section class="settingSection" aria-labelledby="collectionTitle">
      <h3 id="collectionTitle">使用数据</h3>
      <p class="description">
        JinyuTV 不收集、不上传任何使用数据。项目内容、模型配置与偏好设置全部只保存在本机。
      </p>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.privacy {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px 8px;

  .settingSection {
    min-width: 0;

    h3 {
      margin: 0 0 12px;
      color: var(--el-text-color-primary);
      font-size: 14px;
      font-weight: 600;
    }

    .description {
      margin: 0;
      color: var(--el-text-color-secondary);
      font-size: 13px;
      line-height: 1.6;
    }
  }
}
</style>
