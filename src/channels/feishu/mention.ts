interface MentionItem {
  key?: string;
  id?: {
    open_id?: string;
    user_id?: string;
  };
  name?: string;
}

export function extractMentions(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return [];

  const ids: string[] = [];
  for (const mention of mentions as MentionItem[]) {
    const openId = mention?.id?.open_id;
    const userId = mention?.id?.user_id;
    const id = openId ?? userId;
    if (id) ids.push(id);
  }
  return ids;
}

export function isBotMentioned(mentions: string[], botOpenId: string): boolean {
  return mentions.includes(botOpenId);
}

export function stripMentions(text: string): string {
  // Remove @user patterns: @_user_123456 or @xxx style tags from Feishu
  return text
    .replace(/@_user_[a-zA-Z0-9_]+/g, '')
    .replace(/@[^\s]+/g, '')
    .trim();
}
