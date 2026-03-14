export function buildTextCard(text: string, title?: string): object {
  const elements: object[] = [
    {
      tag: 'div',
      text: {
        content: text,
        tag: 'lark_md',
      },
    },
  ];

  const card: Record<string, unknown> = {
    schema: '2.0',
    body: {
      elements,
    },
  };

  if (title) {
    card['header'] = {
      title: {
        content: title,
        tag: 'plain_text',
      },
    };
  }

  return card;
}

export function buildStreamingCard(text: string, done: boolean): object {
  const displayText = done ? text : text + ' ▍';

  const elements: object[] = [
    {
      tag: 'div',
      text: {
        content: displayText,
        tag: 'lark_md',
      },
    },
  ];

  if (!done) {
    elements.push({
      tag: 'div',
      text: {
        content: '_正在思考中..._',
        tag: 'lark_md',
      },
    });
  }

  return {
    schema: '2.0',
    body: {
      elements,
    },
  };
}
